// Telegram long-poll loop and command dispatch. See ../../ARCHITECTURE.md
// "Auth handshake protocol".
//
// Stage 2 commands: /start, /help, /connect, /disconnect, /whoami.
// Stages 3-5 add: /claim, /create, /enter, plus read-only /follow etc.

import { CHAINS, createBudokanClient } from "@provable-games/budokan-sdk";

import type { Config } from "./config.ts";
import type { HandshakeStore } from "./handshake.ts";
import type { SessionStore } from "./session-store.ts";
import { TelegramApi, urlButton, webAppButton } from "./telegram-api.ts";
import { resolveAccount } from "./controller-account.ts";
import {
  buildClaimRewardCall,
  buildEnterTournamentCall,
  buildErc20ApproveCall,
  buildSubmitScoreCall,
  type Call,
  type RewardType,
} from "./budokan-calls.ts";
import * as create from "./commands/create.ts";
import { buildAuthUrl, generateSessionKeypair } from "./cartridge-link.ts";

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

    // Multi-turn /create state takes priority for plain text input. A user
    // typing the next answer should not also trigger an unknown-command path.
    if (!isCommand && create.isPending(chatId)) {
      return create.handleAnswer(this.api, this.config, chatId, text);
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
      case "/submit_score":
      case "/submitscore":
        return this.submitScore(chatId, args);
      case "/claim":
        return this.claim(chatId, args);
      case "/enter":
        return this.enter(chatId, args);
      case "/create":
        return create.start(this.api, chatId);
      default:
        return;
    }
  }

  private async cancel(chatId: string): Promise<void> {
    if (create.cancel(chatId)) {
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

    const result = await resolveAccount(chatId, this.config);
    if (!result.ok) {
      await this.api.sendMessage(chatId, sessionErrorMessage(result.reason));
      return;
    }

    const budokanAddress = this.config.budokanAddress ?? CHAINS[this.config.chain]?.budokanAddress;
    if (!budokanAddress) {
      await this.api.sendMessage(chatId, "Internal error: no Budokan address configured.");
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

    const result = await resolveAccount(chatId, this.config);
    if (!result.ok) {
      await this.api.sendMessage(chatId, sessionErrorMessage(result.reason));
      return;
    }

    const budokanAddress = this.config.budokanAddress ?? CHAINS[this.config.chain]?.budokanAddress;
    if (!budokanAddress) {
      await this.api.sendMessage(chatId, "Internal error: no Budokan address configured.");
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

  // /enter <tournamentId>
  // Branches by tournament shape:
  //   - no entry_fee, no entry_requirement → server-side via session
  //   - has entry_fee, no entry_requirement → Mini App per-tx flow (user
  //     confirms approve + enter in browser, paid from their wallet)
  //   - has entry_requirement → punt with deeplink; we don't build a
  //     QualificationProof from scratch in chat
  private async enter(chatId: string, args: string[]): Promise<void> {
    if (args.length !== 1 || !args[0] || !/^\d+$/.test(args[0])) {
      await this.api.sendMessage(chatId, "Usage: /enter <tournamentId>");
      return;
    }
    const tournamentId = args[0];

    const session = await resolveAccount(chatId, this.config);
    if (!session.ok) {
      await this.api.sendMessage(chatId, sessionErrorMessage(session.reason));
      return;
    }

    const budokanAddress = this.config.budokanAddress ?? CHAINS[this.config.chain]?.budokanAddress;
    if (!budokanAddress) {
      await this.api.sendMessage(chatId, "Internal error: no Budokan address configured.");
      return;
    }

    // Fetch tournament metadata to detect fee + requirement. The SDK's
    // BudokanClientConfig types apiBaseUrl as required, but the runtime
    // reads chain defaults when it's omitted — pass only the values we
    // actually have to override and let the SDK fill the rest.
    const sdkClient = createBudokanClient({
      chain: this.config.chain,
      ...(this.config.apiUrl ? { apiBaseUrl: this.config.apiUrl } : {}),
      ...(this.config.rpcUrl ? { rpcUrl: this.config.rpcUrl } : {}),
      ...(this.config.budokanAddress ? { budokanAddress: this.config.budokanAddress } : {}),
      ...(this.config.viewerAddress ? { viewerAddress: this.config.viewerAddress } : {}),
    } as Parameters<typeof createBudokanClient>[0]);
    let tournament;
    try {
      tournament = await sdkClient.getTournament(tournamentId);
    } catch (error) {
      await this.api.sendMessage(chatId, `Couldn't fetch tournament: ${formatError(error)}`);
      return;
    }
    if (!tournament) {
      await this.api.sendMessage(chatId, `Tournament ${tournamentId} not found.`);
      return;
    }

    const hasRequirement = !!tournament.entryRequirement || tournament.hasEntryRequirement === true;
    if (hasRequirement) {
      await this.api.sendMessage(
        chatId,
        [
          "This tournament has an entry requirement (NFT-gated or extension-gated).",
          "Building a qualification proof from chat input isn't supported here.",
          "",
          `Open: https://budokan.gg/tournament/${tournamentId}`,
        ].join("\n"),
      );
      return;
    }

    const enterCall = buildEnterTournamentCall(budokanAddress, {
      tournamentId,
      playerAddress: session.data.address,
    });

    const fee = tournament.entryFeeAmount && tournament.entryFeeToken
      ? { token: tournament.entryFeeToken, amount: tournament.entryFeeAmount }
      : null;

    if (!fee) {
      // Free entry — sessioned execute server-side.
      await this.api.sendMessage(chatId, `Entering tournament ${tournamentId}…`);
      try {
        const tx = await session.data.account.execute([enterCall]);
        await this.api.sendMessage(chatId, `Entered ✓\ntx: ${tx.transaction_hash}`);
      } catch (error) {
        await this.api.sendMessage(chatId, `Entry failed: ${formatError(error)}`);
      }
      return;
    }

    // Paid entry — build approve + enter and route through Mini App tx mode
    // so the user signs the payment in their browser (no funds movement
    // authorized by the bot's session).
    const calls: Call[] = [
      buildErc20ApproveCall(fee.token, budokanAddress, fee.amount),
      enterCall,
    ];
    const summary = [
      `Tournament ${tournamentId} — ${tournament.name || "(unnamed)"}`,
      `Entry fee: ${fee.amount} of ${shortAddr(fee.token)}`,
      "",
      `Calls (${calls.length}):`,
      `  1. approve(${shortAddr(budokanAddress)}, ${fee.amount}) on token ${shortAddr(fee.token)}`,
      `  2. enter_tournament(${tournamentId}, ...)`,
    ].join("\n");

    const handshake = this.handshakes.mint(chatId, "tx", { payload: { calls, summary } });
    const url = `${this.config.miniAppUrl}/?token=${encodeURIComponent(handshake.token)}&mode=tx`;

    await this.api.sendMessage(
      chatId,
      [
        "This tournament has an entry fee.",
        "Tap the button below — the Mini App will open and Cartridge will ask you to approve and submit the payment.",
        "",
        summary,
      ].join("\n"),
      { replyMarkup: webAppButton("Open to confirm payment", url) },
    );
  }

  private async sendHelp(chatId: string): Promise<void> {
    await this.api.sendMessage(
      chatId,
      [
        `Budokan Telegram bot (chain: ${this.config.chain})`,
        "",
        "Auth:",
        "  /connect — authorize the bot via Cartridge in a Telegram Mini App",
        "  /disconnect — clear your stored session",
        "  /whoami — show the connected account",
        "",
        "Signed actions (require /connect first):",
        "  /create — multi-turn flow to create a tournament",
        "  /enter <tournamentId> — enter a tournament (free in chat; paid via Mini App)",
        "  /submit_score <tournamentId> <tokenId> <position>",
        "  /claim <tournamentId> <kind> [args]",
        "    kinds: prize <id> · dist <id> <pos> · position <n> · tournament_creator · game_creator · refund <tokenId>",
        "  /cancel — abort an in-flight /create flow",
      ].join("\n"),
    );
  }

  private async connect(chatId: string): Promise<void> {
    const existing = await this.sessions.get(chatId);
    if (existing) {
      await this.api.sendMessage(
        chatId,
        `Already connected as ${existing.session.username}. Use /disconnect first to start over.`,
      );
      return;
    }

    // Slot-pattern auth: bot mints the session keypair, sends the user to
    // Cartridge's keychain page, and Cartridge redirects back to a callback
    // URL on our server with the auth result encoded as ?startapp=<base64>.
    // Mirrors cartridge-gg/slot's CLI login flow — see cartridge-link.ts.
    const signer = generateSessionKeypair();
    const handshake = this.handshakes.mint(chatId, "connect", { signer });

    const callbackUrl = `${this.config.botPublicUrl}/api/connect/${handshake.token}/callback`;
    const url = buildAuthUrl({
      config: this.config,
      pubKey: signer.pubKey,
      callbackUrl,
    });

    await this.api.sendMessage(
      chatId,
      [
        "Tap the button below to authorize the bot.",
        "",
        "Cartridge opens in your browser, you sign in (passkey / google / etc.) and approve the session policies. When done, return to this chat — I'll confirm the connection here.",
      ].join("\n"),
      { replyMarkup: urlButton("Open Cartridge to authorize", url) },
    );
  }

  private async disconnect(chatId: string): Promise<void> {
    const existing = await this.sessions.get(chatId);
    if (!existing) {
      await this.api.sendMessage(chatId, "No session to disconnect.");
      return;
    }
    await this.sessions.delete(chatId);
    await this.api.sendMessage(chatId, `Disconnected ${existing.session.username}. Run /connect to authorize again.`);
  }

  private async whoami(chatId: string): Promise<void> {
    const session = await this.sessions.get(chatId);
    if (!session) {
      await this.api.sendMessage(chatId, "Not connected. Run /connect to authorize.");
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function sessionErrorMessage(reason: "no_session" | "expired" | "policy_mismatch"): string {
  if (reason === "no_session") return "Not connected — run /connect first.";
  if (reason === "expired") return "Your session expired. Run /connect to authorize again.";
  return "Your session doesn't cover this action. Run /connect again to widen consent.";
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
