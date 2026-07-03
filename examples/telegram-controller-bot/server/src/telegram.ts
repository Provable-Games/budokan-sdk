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
import { TelegramApi, urlButton } from "./telegram-api.ts";
import { resolveAccount } from "./controller-account.ts";
import {
  buildClaimRewardCall,
  type RewardType,
} from "@provable-games/budokan-sdk";
import * as create from "./commands/create.ts";
import * as addPrize from "./commands/add-prize.ts";
import * as enterCmd from "./commands/enter.ts";
import * as submitCmd from "./commands/submit.ts";
import * as bracketCmd from "./commands/bracket.ts";
import type { BracketStore } from "./bracket-store.ts";
import * as listCmds from "./commands/list.ts";
import * as claimCmd from "./commands/claim.ts";
import { distribute } from "./commands/distribute.ts";
import * as leaderboardCmd from "./commands/leaderboard.ts";
import { topup as topupCmd } from "./commands/topup.ts";
import { buildAuthUrl, generateSessionKeypair } from "./cartridge-link.ts";
import { formatError } from "./format-error.ts";

interface TelegramMessage {
  chat: { id: number; type?: string };
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { id: number };
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export class TelegramBot {
  private readonly api: TelegramApi;
  private readonly abort = new AbortController();
  private stopping = false;
  private botUsername = ""; // learned via getMe at startup; used for DM deeplinks

  constructor(
    private readonly config: Config,
    private readonly handshakes: HandshakeStore,
    private readonly sessions: SessionStore,
    private readonly chatStates: ChatStateStore,
    private readonly brackets: BracketStore,
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
    // Learn our own @username so channel cards can build the Sponsor deeplink
    // (t.me/<username>?start=sponsor_<id>). Best-effort.
    await this.api
      .call<{ username?: string }>("getMe", {})
      .then((me) => {
        if (me?.username) {
          this.botUsername = me.username;
          bracketCmd.setBotUsername(me.username);
        }
      })
      .catch((error: unknown) => {
        console.error("getMe failed:", error instanceof Error ? error.message : error);
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
          { timeout: 50, offset, allowed_updates: ["message", "channel_post", "callback_query"] },
          { signal: this.abort.signal },
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          // Diagnostic: log every incoming message/channel_post so we can see
          // whether group/channel commands (e.g. /channel) actually reach the bot.
          const dbg = update.message ?? update.channel_post;
          if (dbg) {
            const chat = dbg.chat as { id: number; type?: string };
            console.log(
              `[update] ${update.message ? "message" : "channel_post"} chat=${chat.id} type=${chat.type ?? "?"} text=${JSON.stringify((dbg.text ?? "").slice(0, 50))}`,
            );
          }
          if (update.message?.text) {
            await this.handleMessage(update.message).catch((error) => {
              console.error("Command handler failed:", formatError(error));
              this.api
                .sendMessage(String(update.message!.chat.id), `Sorry, that command failed: ${formatError(error)}`)
                .catch((err) => console.error("Failed to notify user of error:", formatError(err)));
            });
          } else if (update.channel_post?.text) {
            await this.handleChannelPost(update.channel_post).catch((error) => {
              console.error("Channel post handler failed:", formatError(error));
            });
          } else if (update.callback_query) {
            await this.handleCallback(update.callback_query).catch((error) => {
              console.error("Callback handler failed:", formatError(error));
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
    const isPrivate = (message.chat.type ?? "private") === "private";
    const text = (message.text ?? "").trim();
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = (rawCommand ?? "").split("@")[0]?.toLowerCase();
    const isCommand = command?.startsWith("/") ?? false;

    // In a group/channel the bot is only here to post cards + handle Join taps.
    // Signing/stateful flows key off the chat id, so they must stay in DMs; and
    // we must NOT reply to ordinary chatter (it would spam the chat). Allow only
    // /channel + read-only browse here; everything else is redirected to DM.
    if (!isPrivate) {
      if (!isCommand) return; // ignore non-command chatter silently
      const GROUP_OK = new Set(["/channel", "/tournaments", "/leaderboard", "/help"]);
      if (!GROUP_OK.has(command ?? "")) {
        const link = this.dmDeeplink(command ?? "");
        await this.api
          .sendMessage(
            chatId,
            "👋 Connecting, creating, joining and claiming happen in a private chat with me — tap below to open our DM. Here I just post updates and accept ▶ Join taps.",
            link ? { replyMarkup: { inline_keyboard: [[{ text: "💬 Open a DM with me", url: link }]] } } : {},
          )
          .catch(() => {});
        return;
      }
      // Allowed read-only / channel command — fall through to the switch below.
      // (The pending-flow checks are no-ops here: this is a command, and no flow
      // is ever keyed to a group chat id.)
    }

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
    if (!isCommand && submitCmd.isPending(chatId)) {
      return submitCmd.handleAnswer(this.api, this.config, chatId, text);
    }
    if (!isCommand && claimCmd.isPending(chatId)) {
      return claimCmd.handleAnswer(this.api, this.config, chatId, text);
    }
    if (!isCommand && bracketCmd.isPending(chatId)) {
      return bracketCmd.handleAnswer(this.api, this.config, this.brackets, chatId, text);
    }
    if (!isCommand && leaderboardCmd.isPending(chatId)) {
      return leaderboardCmd.handleAnswer(this.api, this.config, this.chatStates, chatId, text);
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

    // A new command issued mid-flow means the user abandoned the flow they were
    // in (e.g. typing /enter while /create was still asking for a name). Clear
    // the stale flow state first so its leftover prompts can't capture this
    // command's follow-up replies — otherwise the two flows interleave and the
    // wrong handler eats the answer. /cancel and /back operate ON the active
    // flow, so they're exempt.
    if (command !== "/cancel" && command !== "/back" && this.clearPendingFlows(chatId)) {
      await this.api.sendMessage(chatId, "(Abandoning what we were in the middle of.)");
    }

    switch (command) {
      case "/start":
        return this.handleStart(chatId, args);
      case "/help":
        return this.sendHelp(chatId);
      case "/connect":
        return this.connect(chatId);
      case "/disconnect":
        return this.disconnect(chatId);
      case "/whoami":
        return this.whoami(chatId);
      case "/topup":
      case "/top_up":
      case "/topUp": {
        const chain = await this.chatStates.getChain(chatId);
        return topupCmd(this.api, this.config, this.sessions, chatId, chain, args, this.botUsername);
      }
      case "/cancel":
        return this.cancel(chatId);
      case "/back":
        if (create.isPending(chatId)) {
          return create.back(this.api, chatId);
        }
        return this.api.sendMessage(chatId, "Nothing to go back to.");
      case "/submit_score":
      case "/submitscore": {
        const chain = await this.chatStates.getChain(chatId);
        return submitCmd.start(this.api, this.config, chatId, chain, args);
      }
      case "/claim": {
        const chain = await this.chatStates.getChain(chatId);
        // No id → pick a tournament; bare id → prize overview + mine/all.
        // <id> <kind> … stays the power-user direct-claim path.
        if (args.length === 0) {
          return claimCmd.startPicker(this.api, this.config, chatId, chain);
        }
        if (args.length === 1 && /^\d+$/.test(args[0]!)) {
          return claimCmd.showClaimView(this.api, this.config, chatId, chain, args[0]!);
        }
        return this.claim(chatId, args);
      }
      case "/distribute": {
        const chain = await this.chatStates.getChain(chatId);
        return distribute(this.api, this.config, chatId, chain, args);
      }
      case "/bracket": {
        const chain = await this.chatStates.getChain(chatId);
        return bracketCmd.start(this.api, this.config, chatId, chain);
      }
      case "/brackets": {
        const chain = await this.chatStates.getChain(chatId);
        return bracketCmd.list(this.api, this.brackets, chatId, chain);
      }
      case "/bracket_view":
      case "/bracketview": {
        const id = args[0];
        if (!id) return this.api.sendMessage(chatId, "Usage: /bracket_view <id>");
        return bracketCmd.view(this.api, this.brackets, chatId, id);
      }
      case "/join":
      case "/bracket_join": // legacy alias
      case "/bracketjoin": {
        const id = args[0];
        if (!id) return this.api.sendMessage(chatId, "Usage: /join <id>");
        const chain = await this.chatStates.getChain(chatId);
        return bracketCmd.join(this.api, this.config, this.brackets, chatId, chain, id);
      }
      case "/sponsor":
      case "/bracket_sponsor": // legacy alias
      case "/bracketsponsor": {
        const id = args[0];
        const target = args[1];
        if (!id || !target) {
          return this.api.sendMessage(chatId, "Usage: /sponsor <id> <address or Cartridge username>");
        }
        return bracketCmd.sponsorPaid(this.api, this.config, this.brackets, chatId, id, target);
      }
      case "/channel":
      case "/bracket_channel": // legacy alias
      case "/bracketchannel":
        // Run in the target group to make cards post there.
        return bracketCmd.setAnnounceChannel(this.api, this.brackets, chatId);
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
      case "/tournaments": {
        const chain = await this.chatStates.getChain(chatId);
        // /tournaments <bracketId> → view that bracket's tree (folds in /bracket_view).
        if (args[0]) {
          const b = await this.brackets.get(args[0]).catch(() => null);
          if (b) return bracketCmd.view(this.api, this.brackets, chatId, args[0]!);
        }
        // Brackets section (folds in /brackets), then the tournament list.
        await bracketCmd.list(this.api, this.brackets, chatId, chain, true);
        return listCmds.tournaments(this.api, this.config, this.chatStates, chatId, args);
      }
      case "/my_tournaments":
      case "/my-tournaments":
      case "/mytournaments":
        return listCmds.myTournaments(this.api, this.config, this.chatStates, this.sessions, chatId, args);
      case "/leaderboard":
        return leaderboardCmd.leaderboard(this.api, this.config, this.chatStates, chatId, args);
      default:
        return;
    }
  }

  private async cancel(chatId: string): Promise<void> {
    if (this.clearPendingFlows(chatId)) {
      await this.api.sendMessage(chatId, "Cancelled.");
    } else {
      await this.api.sendMessage(chatId, "Nothing to cancel.");
    }
  }

  /**
   * Cancel every in-progress multi-turn flow for a chat. Returns true if any
   * was active. Cancels ALL of them (not short-circuited) so a chat can't be
   * left with a second flow still pending — which is exactly how /create and
   * /enter previously got tangled.
   */
  /**
   * Advance every running bracket once: resolve finished matches and enter
   * winners into their gated next match. Called on an interval from index.ts.
   * Best-effort per bracket — one failure doesn't stop the others.
   */
  async bracketTick(): Promise<void> {
    let running;
    try {
      running = await this.brackets.running();
    } catch (error) {
      console.error("bracketTick: list failed:", formatError(error));
      return;
    }
    for (const b of running) {
      try {
        await bracketCmd.advanceStoredBracket(this.api, this.config, this.brackets, b);
      } catch (error) {
        console.error(`bracketTick: ${b.state.id} failed:`, formatError(error));
      }
    }
  }

  private clearPendingFlows(chatId: string): boolean {
    const cancelled = [
      create.cancel(chatId),
      addPrize.cancel(chatId),
      enterCmd.cancel(chatId),
      submitCmd.cancel(chatId),
      claimCmd.cancel(chatId),
      bracketCmd.cancel(chatId),
      leaderboardCmd.cancel(chatId),
    ];
    return cancelled.some(Boolean);
  }

  // /claim <tournamentId> <kind> [<kindArgs...>]
  //   /claim 42 prize 7                  → RewardType::Prize(PrizeType::Single(7))
  //   /claim 42 dist 7 2                 → RewardType::Prize(PrizeType::Distributed((7, 2)))
  //   /claim 42 position 1               → RewardType::EntryFee(EntryFeeRewardType::Position(1))
  //   /claim 42 tournament_creator       → RewardType::EntryFee(EntryFeeRewardType::TournamentCreator)
  //   /claim 42 game_creator             → RewardType::EntryFee(EntryFeeRewardType::GameCreator)
  //   /claim 42 refund 0xTOKEN           → RewardType::EntryFee(EntryFeeRewardType::Refund(token))
  private async claim(chatId: string, args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.api.sendMessage(chatId, claimUsage());
      return;
    }
    const [tournamentIdRaw, kindRaw, ...rest] = args;
    if (!/^\d+$/.test(tournamentIdRaw!)) {
      await this.api.sendMessage(chatId, "tournamentId must be a positive integer.");
      return;
    }

    const chain = await this.chatStates.getChain(chatId);

    // Bare id → claim everything the connected wallet can (auto-resolves the
    // wallet's placements). An explicit reward kind keeps the low-level path.
    if (args.length === 1) {
      await claimCmd.claimAll(this.api, this.config, chatId, chain, tournamentIdRaw!);
      return;
    }

    const reward = parseRewardType(kindRaw!.toLowerCase(), rest);
    if (!reward) {
      await this.api.sendMessage(chatId, claimUsage());
      return;
    }

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

  /**
   * /start [payload]. A bare /start shows help. A deep-link payload minted by
   * the read-only tournament bot's handoff resumes that action in this DM: set
   * the chain, then dispatch to the matching command. Two payload shapes:
   *   - `<action>_<id>_<chain>`  → enter / claim (need a tournament id)
   *   - `<action>_<chain>`       → connect / create (no id)
   * The dispatched command prompts /connect when there's no session yet, so an
   * unconnected first-timer lands on a clear next step rather than a dead end.
   */
  /** A t.me link into the bot's DM, pre-starting the flow for create/connect. */
  private dmDeeplink(command: string): string | undefined {
    if (!this.botUsername) return undefined;
    const base = `https://t.me/${this.botUsername}`;
    if (command === "/create") return `${base}?start=create`;
    if (command === "/connect") return `${base}?start=connect`;
    return base; // generic: just open the DM
  }

  /**
   * Posts in a broadcast channel arrive as `channel_post` (the bot must be an
   * admin to receive them). Only `/channel` is actionable here — it registers
   * this channel as the announce target so bracket/tournament cards post here.
   * Everything else needs a DM session and is ignored.
   */
  private async handleChannelPost(post: TelegramMessage): Promise<void> {
    const text = (post.text ?? "").trim();
    const cmd = text.split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
    if (cmd === "/channel") {
      await bracketCmd.setAnnounceChannel(this.api, this.brackets, String(post.chat.id));
    }
  }

  /**
   * Inline-button taps. Currently only the /tournaments list "Enter" buttons,
   * whose callback_data is `enter:<id>`. We ack the tap (stop the spinner) then
   * dispatch to the same /enter path a typed command would take.
   */
  private async handleCallback(cb: TelegramCallbackQuery): Promise<void> {
    const [action, arg] = (cb.data ?? "").split(":");

    // Public "Join" button: identify the player by from.id (== their DM chat id)
    // and join via their session. joinViaButton answers with a private toast, so
    // don't pre-ack here.
    if (action === "bjoin" && arg) {
      return bracketCmd.joinViaButton(this.api, this.config, this.brackets, cb.id, cb.from?.id, arg);
    }
    // Sponsor button: needs a target, so point the tapper to the DM command.
    if (action === "bspon" && arg) {
      return bracketCmd.sponsorViaButton(this.api, cb.id, arg);
    }

    await this.api.answerCallback(cb.id);
    const chatId = cb.message ? String(cb.message.chat.id) : undefined;
    if (!chatId) return;

    if (action === "enter" && arg && /^\d+$/.test(arg)) {
      // Tapping Enter abandons any half-finished flow, same as issuing the
      // command would (see handleMessage).
      if (this.clearPendingFlows(chatId)) {
        await this.api.sendMessage(chatId, "(Abandoning what we were in the middle of.)");
      }
      const chain = await this.chatStates.getChain(chatId);
      return enterCmd.start(this.api, this.config, this.handshakes, chatId, chain, [arg]);
    }
  }

  private async handleStart(chatId: string, args: string[]): Promise<void> {
    const payload = args[0];
    if (!payload) return this.sendHelp(chatId);

    // Payload chars are restricted to [A-Za-z0-9_-] by Telegram, so a simple
    // split is safe.
    const parts = payload.split("_");
    const action = parts[0];

    // Action-only handoffs: connect / create. Shape: action_chain.
    if (action === "connect" || action === "create") {
      const maybeChain = parts[1];
      if (maybeChain && isChain(maybeChain)) {
        await this.chatStates.setChain(chatId, maybeChain);
      }
      if (action === "connect") return this.connect(chatId);
      const chain = await this.chatStates.getChain(chatId);
      return create.start(this.api, chatId, chain);
    }

    // Tournament-scoped handoffs: enter / claim. Shape: action_id_chain.
    if (action === "enter" || action === "claim") {
      const id = parts[1];
      const chain = parts[2];
      if (!id || !/^\d+$/.test(id) || !chain || !isChain(chain)) {
        return this.sendHelp(chatId);
      }
      await this.chatStates.setChain(chatId, chain);

      if (action === "enter") {
        await this.api.sendMessage(chatId, `🎮 Let's get you into tournament #${id} on ${chain}.`);
        return enterCmd.start(this.api, this.config, this.handshakes, chatId, chain, [id]);
      }
      await this.api.sendMessage(chatId, `🏆 Let's claim your rewards for tournament #${id} on ${chain}.`);
      return this.claim(chatId, [id]);
    }

    // Bracket sponsor handoff. Shape: sponsor_<bracketId>. The id can contain
    // '_'/'-', so take everything after the "sponsor_" prefix.
    if (action === "sponsor") {
      const bracketId = payload.slice("sponsor_".length);
      if (!bracketId) return this.sendHelp(chatId);
      return bracketCmd.startSponsorFlow(this.api, this.config, this.brackets, chatId, bracketId);
    }

    // Unknown/garbled payload — fall back to a normal welcome.
    return this.sendHelp(chatId);
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
        ...(this.config.topupUrl
          ? ["  /topup [address] — add funds to your wallet (or a given address)"]
          : []),
        `  /chain [${SUPPORTED_CHAINS.join("|")}] — show or switch your active chain`,
        "",
        "Browse:",
        "  /tournaments [phase] [page] — list tournaments + brackets on this chain. /tournaments <bracketId> shows a bracket's tree.",
        "  /my_tournaments [page] — list tournaments you've entered",
        "  /leaderboard [tournamentId] [page] — show a tournament's scores ranking (no id → picker)",
        "",
        "Signed actions (require /connect first):",
        "  /create — create a single tournament OR a 1v1 single-elim bracket (it asks which first). Brackets: closed (paste players) or open (people join till full); players can be 0x addresses or Cartridge usernames.",
        "  /enter [tournamentId] — enter a tournament (no id → picker; paid entries use your session spending limit, or fall back to a budokan.gg link)",
        "  /join <id> — join an open bracket (after /connect)",
        "  /sponsor <id> <address|username> — pay/sponsor another player's bracket entry",
        "  /submit_score [tournamentId] — submit your scores to the leaderboard (no id → pick from your entries; then submit one or all)",
        "  /claim [tournamentId] — see the prizes up for grabs, then claim your rewards ('mine') or pay out everyone ('all'). No id → pick from your entries.",
        "    Power-user: /claim <tournamentId> <kind> — prize <id> · dist <id> <pos> · position <n> · tournament_creator · game_creator · refund <tokenId>",
        "  /distribute <tournamentId> — pay out every unclaimed reward to all winners (permissionless; same as /claim → 'all')",
        "  /add_prize [tournamentId] — add a prize pool (opens budokan.gg)",
        "",
        "Groups/channels:",
        "  /channel — run in a public group to post bracket/tournament cards + updates there",
        "",
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

    // Reuse an existing session when it's still valid AND covers the current
    // policies — re-authorizing mints a new session (another register_session
    // gas tx), so only do it when necessary. resolveAccount distinguishes a
    // valid session from expired / policy-mismatch / none.
    const status = await resolveAccount(chatId, chain, this.config);
    if (status.ok) {
      const stored = await this.sessions.get(chatId, chain);
      const until = stored
        ? ` Valid until ${new Date(Number(stored.session.expiresAt) * 1000)
            .toISOString()
            .slice(0, 16)
            .replace("T", " ")} UTC.`
        : "";
      await this.api.sendMessage(
        chatId,
        [
          `✅ Already connected on ${chain} as ${status.data.username} — your session still covers the current policies, so there's nothing to do (no new gas tx).${until}`,
          "",
          "Use /disconnect only to switch account or force a fresh session.",
        ].join("\n"),
      );
      return;
    }
    if (status.reason === "policy_mismatch") {
      // In-time session, but authorized for a narrower policy set than we now
      // require (e.g. the contract/token list changed) — must re-authorize.
      await this.sessions.delete(chatId, chain).catch(() => {});
      await this.api.sendMessage(
        chatId,
        `Your existing session on ${chain} doesn't cover the current policies (they've changed since you connected). Re-authorizing once below — future /connect calls will reuse it.`,
      );
    }

    // no_session | expired | policy_mismatch → mint a fresh session.
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
  { command: "tournaments", description: "List tournaments & brackets on this chain" },
  { command: "my_tournaments", description: "List tournaments you've entered" },
  { command: "leaderboard", description: "Show a tournament's scores ranking" },
  { command: "create", description: "Create a tournament or a 1v1 bracket" },
  { command: "enter", description: "Enter a tournament" },
  { command: "join", description: "Join an open bracket: /join <id>" },
  { command: "submit_score", description: "Submit your scores to the leaderboard (one or all)" },
  { command: "claim", description: "Claim the rewards your wallet is owed" },
  { command: "sponsor", description: "Pay a player's bracket entry: /sponsor <id> <addr>" },
  { command: "channel", description: "Run in a group to post cards there" },
  { command: "distribute", description: "Pay out every unclaimed reward to all winners (permissionless)" },
  { command: "add_prize", description: "Add a prize pool (opens budokan.gg)" },
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
    "Usage: /claim <tournamentId>          — claim everything your wallet is owed",
    "",
    "Or name a specific reward — /claim <tournamentId> <kind> [args]:",
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
      // Payout positions are 1-indexed; 0 would always revert on-chain.
      if (!pos || !/^\d+$/.test(pos) || Number(pos) < 1) return null;
      return { kind: "prize_distributed", prizeId: id, payoutPosition: Number(pos) };
    }
    case "position": {
      const [n] = rest;
      if (!n || !/^\d+$/.test(n) || Number(n) < 1) return null;
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
