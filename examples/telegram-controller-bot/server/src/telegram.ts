// Telegram long-poll loop and command dispatch. See ../../ARCHITECTURE.md
// "Auth handshake protocol".
//
// Stage 2 commands: /start, /help, /connect, /disconnect, /whoami.
// Stages 3-5 add: /claim, /create, /enter, plus read-only /follow etc.

import { CHAINS } from "@provable-games/budokan-sdk";

import type { Config } from "./config.ts";
import type { Chain, ChatStateStore } from "./chat-state.ts";
import { isChain, SUPPORTED_CHAINS } from "./chat-state.ts";
import type { HandshakeStore } from "./handshake.ts";
import type { SessionStore } from "./session-store.ts";
import { TelegramApi, urlButton, webAppButton } from "./telegram-api.ts";
import { resolveAccount } from "./controller-account.ts";
import {
  buildClaimRewardCall,
  buildSubmitScoreCall,
  type RewardType,
} from "./budokan-calls.ts";
import * as create from "./commands/create.ts";
import * as addPrize from "./commands/add-prize.ts";
import * as enterCmd from "./commands/enter.ts";
import * as listCmds from "./commands/list.ts";
import { buildAuthUrl, generateSessionKeypair } from "./cartridge-link.ts";
import { formatError } from "./format-error.ts";

interface TelegramMessage {
  chat: { id: number };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramBot {
  private readonly api: TelegramApi;
  private readonly abort = new AbortController();
  private stopping = false;

  constructor(
    private readonly config: Config,
    private readonly handshakes: HandshakeStore,
    private readonly sessions: SessionStore,
    private readonly chatStates: ChatStateStore,
  ) {
    this.api = new TelegramApi(config.telegramBotToken);
  }

  /** Reused by the HTTP server to push notifications back to the chat. */
  get telegram(): TelegramApi {
    return this.api;
  }

  async start(): Promise<void> {
    // getUpdates conflicts with a configured webhook; clear in case one is set.
    await this.api.call("deleteWebhook", { drop_pending_updates: false });
    // Populate Telegram's "/" autocomplete with our command list. Best-effort:
    // a transient failure shouldn't block bot startup.
    await this.api
      .call("setMyCommands", { commands: TELEGRAM_COMMAND_MENU })
      .catch((error: unknown) => {
        console.error("setMyCommands failed:", error instanceof Error ? error.message : error);
      });
    await this.poll();
  }

  shutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.abort.abort();
  }

  private async poll(): Promise<void> {
    let offset: number | undefined;
    while (!this.stopping) {
      try {
        const updates = await this.api.call<TelegramUpdate[]>(
          "getUpdates",
          { timeout: 50, offset, allowed_updates: ["message"] },
          { signal: this.abort.signal },
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message?.text) {
            await this.handleMessage(update.message).catch((error) => {
              console.error("Command handler failed:", formatError(error));
              this.api
                .sendMessage(String(update.message!.chat.id), `Sorry, that command failed: ${formatError(error)}`)
                .catch((err) => console.error("Failed to notify user of error:", formatError(err)));
            });
          }
        }
      } catch (error) {
        if (this.stopping || isAbortError(error)) break;
        console.error("Telegram polling failed:", formatError(error));
        await sleep(2000, this.abort.signal);
      }
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const text = (message.text ?? "").trim();
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = (rawCommand ?? "").split("@")[0]?.toLowerCase();
    const isCommand = command?.startsWith("/") ?? false;

    // Multi-turn flows take priority for plain text input. A user typing
    // the next answer should not also trigger an unknown-command path.
    if (!isCommand && create.isPending(chatId)) {
      return create.handleAnswer(this.api, this.config, chatId, text);
    }
    if (!isCommand && addPrize.isPending(chatId)) {
      return addPrize.handleAnswer(this.api, this.config, this.handshakes, chatId, text);
    }
    if (!isCommand && enterCmd.isPending(chatId)) {
      return enterCmd.handleAnswer(this.api, this.config, this.handshakes, chatId, text);
    }
    // Plain text with no pending flow — most often happens when the
    // bot was restarted (Railway redeploy) mid-picker. State is in
    // memory so it gets wiped, and the user is left typing answers
    // into the void. Tell them what happened instead of silently
    // dropping the message.
    if (!isCommand) {
      await this.api.sendMessage(
        chatId,
        "I'm not waiting on a reply right now. (If you were mid-picker, the bot likely restarted — re-run the command.)\nSend /help to see what's available.",
      );
      return;
    }

    switch (command) {
      case "/start":
      case "/help":
        return this.sendHelp(chatId);
      case "/connect":
        return this.connect(chatId);
      case "/disconnect":
        return this.disconnect(chatId);
      case "/whoami":
        return this.whoami(chatId);
      case "/cancel":
        return this.cancel(chatId);
      case "/back":
        if (create.isPending(chatId)) {
          return create.back(this.api, chatId);
        }
        return this.api.sendMessage(chatId, "Nothing to go back to.");
      case "/submit_score":
      case "/submitscore":
        return this.submitScore(chatId, args);
      case "/claim":
        return this.claim(chatId, args);
      case "/enter": {
        const chain = await this.chatStates.getChain(chatId);
        return enterCmd.start(this.api, this.config, this.handshakes, chatId, chain, args);
      }
      case "/create": {
        const chain = await this.chatStates.getChain(chatId);
        return create.start(this.api, chatId, chain);
      }
      case "/add_prize":
      case "/add-prize":
      case "/addprize": {
        const chain = await this.chatStates.getChain(chatId);
        return addPrize.start(this.api, this.config, chatId, chain, args);
      }
      case "/chain":
        return this.chain(chatId, args);
      case "/tournaments":
        return listCmds.tournaments(this.api, this.config, this.chatStates, chatId, args);
      case "/my_tournaments":
      case "/my-tournaments":
      case "/mytournaments":
        return listCmds.myTournaments(this.api, this.config, this.chatStates, this.sessions, chatId, args);
      default:
        return;
    }
  }

  private async cancel(chatId: string): Promise<void> {
    const cancelled = create.cancel(chatId) || addPrize.cancel(chatId) || enterCmd.cancel(chatId);
    if (cancelled) {
      await this.api.sendMessage(chatId, "Cancelled.");
    } else {
      await this.api.sendMessage(chatId, "Nothing to cancel.");
    }
  }

  private async submitScore(chatId: string, args: string[]): Promise<void> {
    if (args.length !== 3) {
      await this.api.sendMessage(
        chatId,
        "Usage: /submit_score <tournamentId> <tokenId> <position>",
      );
      return;
    }
    const [tournamentIdRaw, tokenIdRaw, positionRaw] = args;
    if (!/^\d+$/.test(tournamentIdRaw!)) {
      await this.api.sendMessage(chatId, "tournamentId must be a positive integer.");
      return;
    }
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(tokenIdRaw!)) {
      await this.api.sendMessage(chatId, "tokenId must be a hex (0x…) or decimal integer.");
      return;
    }
    if (!/^\d+$/.test(positionRaw!)) {
      await this.api.sendMessage(chatId, "position must be a positive integer.");
      return;
    }

    const chain = await this.chatStates.getChain(chatId);
    const result = await resolveAccount(chatId, chain, this.config);
    if (!result.ok) {
      await this.api.sendMessage(chatId, sessionErrorMessage(result.reason, chain));
      return;
    }

    const budokanAddress = this.config.budokanAddress ?? CHAINS[chain]?.budokanAddress;
    if (!budokanAddress) {
      await this.api.sendMessage(chatId, `Internal error: no Budokan address configured for ${chain}.`);
      return;
    }

    const call = buildSubmitScoreCall(budokanAddress, {
      tournamentId: tournamentIdRaw!,
      tokenId: tokenIdRaw!,
      position: Number(positionRaw),
    });

    await this.api.sendMessage(chatId, `Submitting score for tournament ${tournamentIdRaw}…`);
    try {
      const tx = await result.data.account.execute([call]);
      await this.api.sendMessage(chatId, `Score submitted ✓\ntx: ${tx.transaction_hash}`);
    } catch (error) {
      await this.api.sendMessage(chatId, `Submission failed: ${formatError(error)}`);
    }
  }

  // /claim <tournamentId> <kind> [<kindArgs...>]
  //   /claim 42 prize 7                  → RewardType::Prize(PrizeType::Single(7))
  //   /claim 42 dist 7 2                 → RewardType::Prize(PrizeType::Distributed((7, 2)))
  //   /claim 42 position 1               → RewardType::EntryFee(EntryFeeRewardType::Position(1))
  //   /claim 42 tournament_creator       → RewardType::EntryFee(EntryFeeRewardType::TournamentCreator)
  //   /claim 42 game_creator             → RewardType::EntryFee(EntryFeeRewardType::GameCreator)
  //   /claim 42 refund 0xTOKEN           → RewardType::EntryFee(EntryFeeRewardType::Refund(token))
  private async claim(chatId: string, args: string[]): Promise<void> {
    if (args.length < 2) {
      await this.api.sendMessage(chatId, claimUsage());
      return;
    }
    const [tournamentIdRaw, kindRaw, ...rest] = args;
    if (!/^\d+$/.test(tournamentIdRaw!)) {
      await this.api.sendMessage(chatId, "tournamentId must be a positive integer.");
      return;
    }
    const reward = parseRewardType(kindRaw!.toLowerCase(), rest);
    if (!reward) {
      await this.api.sendMessage(chatId, claimUsage());
      return;
    }

    const chain = await this.chatStates.getChain(chatId);
    const result = await resolveAccount(chatId, chain, this.config);
    if (!result.ok) {
      await this.api.sendMessage(chatId, sessionErrorMessage(result.reason, chain));
      return;
    }

    const budokanAddress = this.config.budokanAddress ?? CHAINS[chain]?.budokanAddress;
    if (!budokanAddress) {
      await this.api.sendMessage(chatId, `Internal error: no Budokan address configured for ${chain}.`);
      return;
    }

    const call = buildClaimRewardCall(budokanAddress, {
      tournamentId: tournamentIdRaw!,
      reward,
    });

    await this.api.sendMessage(chatId, `Claiming reward for tournament ${tournamentIdRaw}…`);
    try {
      const tx = await result.data.account.execute([call]);
      await this.api.sendMessage(chatId, `Reward claimed ✓\ntx: ${tx.transaction_hash}`);
    } catch (error) {
      await this.api.sendMessage(chatId, `Claim failed: ${formatError(error)}`);
    }
  }

  private async sendHelp(chatId: string): Promise<void> {
    const chain = await this.chatStates.getChain(chatId);
    await this.api.sendMessage(
      chatId,
      [
        `Budokan Telegram bot (your chain: ${chain})`,
        "",
        "Auth:",
        "  /connect — authorize the bot via Cartridge",
        "  /disconnect — clear your stored session",
        "  /whoami — show the connected account",
        `  /chain [${SUPPORTED_CHAINS.join("|")}] — show or switch your active chain`,
        "",
        "Browse:",
        "  /tournaments [phase] [page] — list tournaments on this chain",
        "  /my_tournaments [page] — list tournaments you've entered",
        "",
        "Signed actions (require /connect first):",
        "  /create — multi-turn flow to create a tournament",
        "  /enter [tournamentId] — enter a tournament (no id → picker; paid via Mini App)",
        "  /submit_score <tournamentId> <tokenId> <position>",
        "  /claim <tournamentId> <kind> [args]",
        "    kinds: prize <id> · dist <id> <pos> · position <n> · tournament_creator · game_creator · refund <tokenId>",
        "  /add_prize [tournamentId] — sponsor an ERC-20 prize (no id → picker)",
        "  /cancel — abort an in-flight multi-turn flow",
        "  /back — during /create, edit the current (or last) section. At the confirmation, 'edit N' jumps to section N.",
      ].join("\n"),
    );
  }

  private async chain(chatId: string, args: string[]): Promise<void> {
    const current = await this.chatStates.getChain(chatId);
    if (args.length === 0) {
      await this.api.sendMessage(
        chatId,
        `Your current chain: ${current}\nUsage: /chain ${SUPPORTED_CHAINS.join("|")}`,
      );
      return;
    }
    const target = (args[0] ?? "").toLowerCase();
    if (!isChain(target)) {
      await this.api.sendMessage(chatId, `Chain must be one of: ${SUPPORTED_CHAINS.join(", ")}`);
      return;
    }
    if (target === current) {
      await this.api.sendMessage(chatId, `Already on ${current}.`);
      return;
    }
    await this.chatStates.setChain(chatId, target);
    const session = await this.sessions.get(chatId, target);
    const note = session
      ? `You have an active session on ${target} as ${session.session.username}.`
      : `No session on ${target} yet — run /connect to authorize.`;
    await this.api.sendMessage(
      chatId,
      [`Switched to ${target}.`, note, "", `Your session on ${current} is preserved — switch back with /chain ${current}.`].join("\n"),
    );
  }

  private async connect(chatId: string): Promise<void> {
    const chain = await this.chatStates.getChain(chatId);
    const existing = await this.sessions.get(chatId, chain);
    if (existing) {
      await this.api.sendMessage(
        chatId,
        `Already connected on ${chain} as ${existing.session.username}. Use /disconnect first to start over, or /chain to switch.`,
      );
      return;
    }

    // Slot-pattern auth: bot mints the session keypair, sends the user to
    // Cartridge's keychain page, and Cartridge redirects back to a callback
    // URL on our server with the auth result encoded as ?startapp=<base64>.
    // Mirrors cartridge-gg/slot's CLI login flow — see cartridge-link.ts.
    const signer = generateSessionKeypair();
    const handshake = this.handshakes.mint(chatId, "connect", chain, { signer });

    const callbackUrl = `${this.config.botPublicUrl}/api/connect/${handshake.token}/callback`;
    const url = buildAuthUrl({
      config: this.config,
      chain,
      pubKey: signer.pubKey,
      callbackUrl,
    });

    await this.api.sendMessage(
      chatId,
      [
        `Tap the button below to authorize the bot on ${chain}.`,
        "",
        "Cartridge opens in your browser, you sign in (passkey / google / etc.) and approve the session policies. When done, return to this chat — I'll confirm the connection here.",
      ].join("\n"),
      { replyMarkup: urlButton("Open Cartridge to authorize", url) },
    );
  }

  private async disconnect(chatId: string): Promise<void> {
    const chain = await this.chatStates.getChain(chatId);
    const existing = await this.sessions.get(chatId, chain);
    if (!existing) {
      await this.api.sendMessage(chatId, `No session on ${chain} to disconnect.`);
      return;
    }
    await this.sessions.delete(chatId, chain);
    await this.api.sendMessage(
      chatId,
      `Disconnected ${existing.session.username} on ${chain}. Run /connect to authorize again.`,
    );
  }

  private async whoami(chatId: string): Promise<void> {
    const chain = await this.chatStates.getChain(chatId);
    const session = await this.sessions.get(chatId, chain);
    if (!session) {
      await this.api.sendMessage(chatId, `Not connected on ${chain}. Run /connect to authorize.`);
      return;
    }
    const expiresAt = new Date(Number(session.session.expiresAt) * 1000);
    await this.api.sendMessage(
      chatId,
      [
        `Username: ${session.session.username}`,
        `Address: ${session.session.address}`,
        `Chain: ${session.chain}`,
        `Session expires: ${expiresAt.toISOString()}`,
      ].join("\n"),
    );
  }

  private miniAppUrl(token: string, mode: "connect" | "tx"): string {
    const base = this.config.miniAppUrl;
    return `${base}/?token=${encodeURIComponent(token)}&mode=${mode}`;
  }
}

// Telegram's setMyCommands payload — descriptions show in the "/" autocomplete
// dropdown in chat. Keep this in sync with sendHelp() and the command switch
// in handleMessage(). Order shown is the order Telegram displays.
const TELEGRAM_COMMAND_MENU: Array<{ command: string; description: string }> = [
  { command: "start", description: "Show help" },
  { command: "help", description: "Show command list" },
  { command: "connect", description: "Authorize the bot via Cartridge" },
  { command: "disconnect", description: "Clear your stored session" },
  { command: "whoami", description: "Show the connected account" },
  { command: "chain", description: "Show or switch your active chain" },
  { command: "tournaments", description: "List tournaments on this chain" },
  { command: "my_tournaments", description: "List tournaments you've entered" },
  { command: "create", description: "Multi-turn flow to create a tournament" },
  { command: "enter", description: "Enter a tournament" },
  { command: "submit_score", description: "Submit a score" },
  { command: "claim", description: "Claim a reward" },
  { command: "add_prize", description: "Sponsor a prize for a tournament" },
  { command: "back", description: "Go back / edit the current section in /create" },
  { command: "cancel", description: "Abort the current multi-turn flow" },
];

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function sessionErrorMessage(reason: "no_session" | "expired" | "policy_mismatch", chain: Chain): string {
  if (reason === "no_session") return `Not connected on ${chain} — run /connect first.`;
  if (reason === "expired") return `Your session on ${chain} expired. Run /connect to authorize again.`;
  return `Your session on ${chain} doesn't cover this action. Run /connect again to widen consent.`;
}

function claimUsage(): string {
  return [
    "Usage: /claim <tournamentId> <kind> [args]",
    "  /claim 42 prize 7                 — single sponsored prize id 7",
    "  /claim 42 dist 7 2                — distributed prize 7, payout position 2",
    "  /claim 42 position 1              — entry-fee share for placement 1",
    "  /claim 42 tournament_creator",
    "  /claim 42 game_creator",
    "  /claim 42 refund 0xTOKEN          — refund for a bought-in entry",
  ].join("\n");
}

function parseRewardType(kind: string, rest: string[]): RewardType | null {
  switch (kind) {
    case "prize": {
      const [id] = rest;
      if (!id || !/^\d+$/.test(id)) return null;
      return { kind: "prize_single", prizeId: id };
    }
    case "dist": {
      const [id, pos] = rest;
      if (!id || !/^\d+$/.test(id)) return null;
      if (!pos || !/^\d+$/.test(pos)) return null;
      return { kind: "prize_distributed", prizeId: id, payoutPosition: Number(pos) };
    }
    case "position": {
      const [n] = rest;
      if (!n || !/^\d+$/.test(n)) return null;
      return { kind: "entry_fee_position", position: Number(n) };
    }
    case "tournament_creator":
      return { kind: "entry_fee_tournament_creator" };
    case "game_creator":
      return { kind: "entry_fee_game_creator" };
    case "refund": {
      const [token] = rest;
      if (!token || !/^(0x[0-9a-fA-F]+|\d+)$/.test(token)) return null;
      return { kind: "entry_fee_refund", tokenId: token };
    }
    default:
      return null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cleanup);
      resolve();
    };
    const timeout = setTimeout(cleanup, ms);
    signal?.addEventListener("abort", cleanup, { once: true });
  });
}
