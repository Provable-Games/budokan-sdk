// /bracket — organizer flow to create + run an off-chain 1v1 single-elim
// bracket over Budokan tournaments, with on-chain gating (each round's entry
// requires having won the feeder match). See budokan-sdk `src/brackets`.
//
// Three rosters:
//   - closed: organizer pastes every player up front (addresses or Cartridge
//     usernames) → deploys immediately.
//   - open:   organizer sets a capacity; players /bracket_join until full,
//     then it auto-starts.
//   - mix:    organizer seeds some players + opens the remaining slots.
//
// The whole tree is deployed up front; the bot enters round-1 players on their
// behalf and, as rounds resolve, enters winners into the next gated match.
// Progression is handled by the poller (advanceStoredBracket).

import {
  CHAINS,
  createBudokanClient,
  createBracket,
  advanceBracket,
  attachMatchTournament,
  bracketEntryCalls,
  bracketFinalPrizeCalls,
  bracketFeePrizeCalls,
  bracketRounds,
  bracketSummary,
  parseTournamentIdFromReceipt,
  roundMatchCreateCalls,
  tournamentPageUrl,
  type BracketState,
  type MatchReader,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient } from "@provable-games/denshokan-sdk";
import { num, RpcProvider } from "starknet";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import { TelegramApi, type InlineKeyboardButton } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { keychainSafeRpcUrl } from "../cartridge-link.ts";
import { gamesForChain, type Game } from "../catalog/games.ts";
import { tokensForChain, type Erc20Token } from "../catalog/tokens.ts";
import { fetchSettings, type SettingsPage } from "../catalog/settings.ts";
import { formatError } from "../format-error.ts";
import { BracketStore, type BracketRegistration, type StoredBracket } from "../bracket-store.ts";

type Player = { address: string; name?: string };

// Per-match schedule presets (durations in seconds).
const LENGTH_PRESETS = [
  { label: "Quick — 15m sign-up, 30m matches", reg: 900, game: 1800, sub: 900 },
  { label: "Standard — 1h sign-up, 6h matches", reg: 3600, game: 21600, sub: 3600 },
  { label: "Daily — 6h sign-up, 24h matches", reg: 21600, game: 86400, sub: 21600 },
] as const;

const MODES = [
  { key: "closed", label: "Closed — I'll paste all players now" },
  { key: "open", label: "Open — players join until full, then it starts" },
  { key: "mix", label: "Mix — I seed some, others join the rest" },
] as const;

const CAPACITIES = [4, 8, 16, 32] as const;

interface Draft {
  step:
    | "game"
    | "settings"
    | "mode"
    | "capacity"
    | "players"
    | "length"
    | "prizeToken"
    | "prizeAmount"
    | "feeToken"
    | "feeAmount"
    | "feeSplit"
    | "feeCustom"
    | "confirm";
  chain: Chain;
  games: Game[];
  game?: Game;
  settingsId?: number;
  settingsName?: string;
  settingsPage?: SettingsPage;
  mode?: (typeof MODES)[number]["key"];
  capacity?: number;
  players?: Player[]; // closed: everyone; mix: seeds; open: undefined
  length?: (typeof LENGTH_PRESETS)[number];
  prizeToken?: Erc20Token;
  prize?: { tokenAddress: string; amount: string; label: string };
  // Paid (open mode only): players pay this fee on tap; it escrows into
  // placement prizes per tiersBps (basis points per tier). Collected over the
  // feeToken → feeAmount → feeSplit sub-flow.
  feeToken?: Erc20Token;
  feeAmountRaw?: string;
  feeAmountLabel?: string;
  entryFee?: { tokenAddress: string; amount: string; label: string };
  tiersBps?: number[];
}

// Prize-split presets (basis points per placement tier: champion, runner-up,
// semifinalists, quarterfinalists). Tiers deeper than the bracket are ignored;
// a tier's bps is shared equally across that round's losers (see
// bracketFeePrizeCalls). Mirrors the spirit of Budokan's payout distribution.
const FEE_SPLITS = [
  { label: "Winner takes all (100%)", bps: [10000] },
  { label: "Top 2 — 70% / 30%", bps: [7000, 3000] },
  { label: "Top 4 — 50% / 25% / 25% (champion / runner-up / semis)", bps: [5000, 2500, 2500] },
  { label: "Top 8 — 40 / 20 / 20 / 20 (champion / runner-up / semis / QFs)", bps: [4000, 2000, 2000, 2000] },
] as const;

const drafts = new Map<string, Draft>();

export function isPending(chatId: string): boolean {
  return drafts.has(chatId);
}
export function cancel(chatId: string): boolean {
  return drafts.delete(chatId);
}

const isPow2 = (n: number) => n >= 2 && (n & (n - 1)) === 0;

// ----- create flow -----

export async function start(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
): Promise<void> {
  const session = await resolveAccount(chatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(chatId, `Not connected on ${chain} — run /connect first (the organizer wallet creates the matches).`);
    return;
  }
  const games = await gamesForChain(chain);
  if (games.length === 0) {
    await api.sendMessage(chatId, `No games available on ${chain}.`);
    return;
  }
  drafts.set(chatId, { step: "game", chain, games });
  const lines = [`🏗️ New bracket on ${chain} — pick a game:`, ""];
  games.forEach((g, i) => lines.push(`  ${i + 1}. ${g.name}`));
  lines.push("", "Reply with a number. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

export async function handleAnswer(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  text: string,
): Promise<void> {
  const d = drafts.get(chatId);
  if (!d) return;
  const t = text.trim();

  if (d.step === "game") {
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > d.games.length) {
      await api.sendMessage(chatId, `Reply 1–${d.games.length}, or /cancel.`);
      return;
    }
    d.game = d.games[n - 1];
    await renderBracketSettings(api, d, chatId, 0);
    return;
  }

  if (d.step === "settings") {
    await handleBracketSettings(api, d, chatId, t);
    return;
  }

  if (d.step === "mode") {
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > MODES.length) {
      await api.sendMessage(chatId, `Reply 1–${MODES.length}, or /cancel.`);
      return;
    }
    d.mode = MODES[n - 1]!.key;
    if (d.mode === "closed") {
      d.step = "players";
      await api.sendMessage(chatId, pastePrompt("everyone"));
    } else {
      d.step = "capacity";
      const lines = [`Pick the bracket size (capacity):`, ""];
      CAPACITIES.forEach((c, i) => lines.push(`  ${i + 1}. ${c} players`));
      lines.push("", "Reply with a number. /cancel to abort.");
      await api.sendMessage(chatId, lines.join("\n"));
    }
    return;
  }

  if (d.step === "capacity") {
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > CAPACITIES.length) {
      await api.sendMessage(chatId, `Reply 1–${CAPACITIES.length}, or /cancel.`);
      return;
    }
    d.capacity = CAPACITIES[n - 1];
    if (d.mode === "mix") {
      d.step = "players";
      await api.sendMessage(chatId, pastePrompt(`up to ${d.capacity! - 1} seeds (leave the rest open)`));
    } else {
      // open: no seeds
      d.players = [];
      d.step = "length";
      await sendLengthPrompt(api, chatId);
    }
    return;
  }

  if (d.step === "players") {
    const { players, unresolved } = await resolvePlayers(d.chain, t);
    if (unresolved.length > 0) {
      await api.sendMessage(chatId, `Couldn't resolve these Cartridge usernames: ${unresolved.join(", ")}. Fix and resend, or /cancel.`);
      return;
    }
    if (players.length === 0) {
      await api.sendMessage(chatId, "No players parsed. Paste addresses or Cartridge usernames, or /cancel.");
      return;
    }
    if (d.mode === "closed") {
      if (!isPow2(players.length)) {
        await api.sendMessage(chatId, `Got ${players.length}. A closed bracket needs a power of two (2, 4, 8, 16…). Resend, or /cancel.`);
        return;
      }
      d.capacity = players.length;
    } else {
      // mix seeds: must be < capacity and leave a power-of-two final size
      if (players.length >= d.capacity!) {
        await api.sendMessage(chatId, `That's ${players.length} seeds for a ${d.capacity}-player bracket — leave at least one open slot, or use a bigger size. /cancel to abort.`);
        return;
      }
    }
    d.players = players;
    d.step = "length";
    await sendLengthPrompt(api, chatId);
    return;
  }

  if (d.step === "length") {
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > LENGTH_PRESETS.length) {
      await api.sendMessage(chatId, `Reply 1–${LENGTH_PRESETS.length}, or /cancel.`);
      return;
    }
    d.length = LENGTH_PRESETS[n - 1];
    // Open brackets fund prizes from entry fees (the pool) — go straight to the
    // fee flow. Closed/mix have no pool, so offer an optional sponsored prize.
    if (d.mode === "open") {
      d.step = "feeToken";
      await sendFeeTokenPrompt(api, d.chain, chatId);
      return;
    }
    d.step = "prizeToken";
    await sendTokenList(api, d.chain, chatId, "🏆 Champion prize — pick a token:", "No prize");
    return;
  }

  if (d.step === "prizeToken") {
    if (/^(0|skip|none|no)$/i.test(t)) {
      d.step = "confirm";
      await api.sendMessage(chatId, confirmText(d));
      return;
    }
    const tokens = tokensForChain(d.chain);
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > tokens.length) {
      await api.sendMessage(chatId, `Reply 1–${tokens.length} to pick a token, 0 for no prize, or /cancel.`);
      return;
    }
    d.prizeToken = tokens[n - 1];
    d.step = "prizeAmount";
    await api.sendMessage(chatId, `🏆 Champion prize amount in ${d.prizeToken!.symbol}? (e.g. 100) /cancel to abort.`);
    return;
  }

  if (d.step === "prizeAmount") {
    if (!/^\d+(\.\d+)?$/.test(t)) {
      await api.sendMessage(chatId, `Enter a number in ${d.prizeToken!.symbol} (e.g. 100), or /cancel.`);
      return;
    }
    d.prize = {
      tokenAddress: d.prizeToken!.address,
      amount: toRawAmount(t, d.prizeToken!.decimals),
      label: `${t} ${d.prizeToken!.symbol}`,
    };
    d.step = "confirm";
    await api.sendMessage(chatId, confirmText(d));
    return;
  }

  if (d.step === "feeToken") {
    if (/^(0|skip|none|no)$/i.test(t)) {
      // No entry fee → offer an optional sponsored champion prize instead.
      d.step = "prizeToken";
      await sendTokenList(api, d.chain, chatId, "🏆 Champion prize — pick a token:", "No prize");
      return;
    }
    const tokens = tokensForChain(d.chain);
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > tokens.length) {
      await api.sendMessage(chatId, `Reply 1–${tokens.length} to pick a token, 0 for a free bracket, or /cancel.`);
      return;
    }
    d.feeToken = tokens[n - 1];
    d.step = "feeAmount";
    await api.sendMessage(chatId, `💸 Entry fee amount in ${d.feeToken!.symbol}? (e.g. 100) /cancel to abort.`);
    return;
  }

  if (d.step === "feeAmount") {
    if (!/^\d+(\.\d+)?$/.test(t)) {
      await api.sendMessage(chatId, `Enter a number in ${d.feeToken!.symbol} (e.g. 100), or /cancel.`);
      return;
    }
    d.feeAmountRaw = toRawAmount(t, d.feeToken!.decimals);
    d.feeAmountLabel = `${t} ${d.feeToken!.symbol}`;
    d.step = "feeSplit";
    await sendFeeSplitPrompt(api, chatId);
    return;
  }

  if (d.step === "feeSplit") {
    if (/^custom$/i.test(t) || Number(t) === FEE_SPLITS.length + 1) {
      d.step = "feeCustom";
      await api.sendMessage(
        chatId,
        "Enter the split as whole % summing to 100 — 1st, then 2nd, then semifinalists, then quarterfinalists. E.g. `60 30 10`. /cancel to abort.",
      );
      return;
    }
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > FEE_SPLITS.length) {
      await api.sendMessage(chatId, `Reply 1–${FEE_SPLITS.length + 1}, or /cancel.`);
      return;
    }
    d.tiersBps = [...FEE_SPLITS[n - 1]!.bps];
    d.entryFee = { tokenAddress: d.feeToken!.address, amount: d.feeAmountRaw!, label: d.feeAmountLabel! };
    d.step = "confirm";
    await api.sendMessage(chatId, confirmText(d));
    return;
  }

  if (d.step === "feeCustom") {
    const places = t.split(/\s+/).map(Number);
    if (
      places.length === 0 ||
      places.some((p) => !Number.isFinite(p) || p < 0) ||
      places.reduce((a, b) => a + b, 0) !== 100
    ) {
      await api.sendMessage(chatId, "Whole percentages summing to 100 (e.g. `60 30 10`). Try again, or /cancel.");
      return;
    }
    d.tiersBps = places.map((p) => Math.round(p * 100));
    d.entryFee = { tokenAddress: d.feeToken!.address, amount: d.feeAmountRaw!, label: d.feeAmountLabel! };
    d.step = "confirm";
    await api.sendMessage(chatId, confirmText(d));
    return;
  }

  if (d.step === "confirm") {
    if (t.toLowerCase() !== "yes") {
      await api.sendMessage(chatId, "Reply 'yes', or /cancel.");
      return;
    }
    drafts.delete(chatId);
    // Announce target: the channel set via /bracket_channel wins, then the env
    // var, then the organizer's DM.
    const announceChatId = (await store.getAnnounceChannel()) ?? config.bracketChannelId ?? chatId;

    if (d.mode === "closed") {
      await deployResolved(api, config, store, {
        organizerChatId: chatId,
        announceChatId,
        chain: d.chain,
        game: d.game!,
        settingsId: d.settingsId,
        length: d.length!,
        prize: d.prize,
        players: d.players!,
      });
      return;
    }

    // open + entry fee → deploy the tree up front so taps can pay on the spot.
    if (d.mode === "open" && d.entryFee) {
      await deployPaidUpfront(api, config, store, chatId, announceChatId, d);
      return;
    }

    // free open / mix → create a registration that fills before it deploys.
    const reg: BracketRegistration = {
      id: `b${Date.now().toString(36)}`,
      chain: d.chain,
      organizerChatId: chatId,
      announceChatId,
      game: {
        contractAddress: d.game!.contractAddress,
        name: d.game!.name,
        leaderboardAscending: d.game!.leaderboardAscending,
        leaderboardGameMustBeOver: d.game!.leaderboardGameMustBeOver,
      },
      length: { reg: d.length!.reg, game: d.length!.game, sub: d.length!.sub },
      prize: d.prize,
      settingsId: d.settingsId,
      settingsName: d.settingsName,
      capacity: d.capacity!,
      players: d.players ?? [],
      createdAt: Date.now(),
    };
    await store.saveRegistration(reg);
    // Post the live registration card (with a Join button) to the public chat
    // and remember its location so each join can edit it in place.
    const messageId = await api
      .sendCard(reg.announceChatId, registrationCard(reg), joinKeyboard(reg))
      .catch(() => undefined);
    if (messageId !== undefined) {
      reg.cardChatId = reg.announceChatId;
      reg.cardMessageId = messageId;
      await store.saveRegistration(reg);
    }
    await api.sendMessage(
      chatId,
      `✅ Registration ${reg.id} open (${reg.players.length}/${reg.capacity}). Players can tap Join on the card, or /bracket_join ${reg.id} after /connect. Auto-starts when full; /bracket_start ${reg.id} to force-start.`,
    );
    return;
  }
}

/**
 * Set the chat this command is run in as the bracket announce channel — run
 * /bracket_channel inside the public group. Replaces needing BRACKET_CHANNEL_ID.
 */
export async function setAnnounceChannel(
  api: TelegramApi,
  store: BracketStore,
  chatId: string,
): Promise<void> {
  await store.setAnnounceChannel(chatId);
  const where = chatId.startsWith("-") ? "this group" : "this chat";
  await api.sendMessage(
    chatId,
    `✅ Bracket cards & updates will post in ${where} from now on. (New brackets only — existing ones keep their channel.)`,
  );
}

// ----- join / start (open & mix) -----

export async function join(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  chain: Chain,
  id: string,
): Promise<void> {
  const reg = await store.getRegistration(id);
  if (!reg) {
    // Paid up-front bracket? Join + pay via the player's session.
    const b = await store.get(id);
    if (b?.phase === "filling") {
      const toast = await paidJoin(api, config, store, b, chatId);
      await api.sendMessage(chatId, toast);
      return;
    }
    await api.sendMessage(chatId, `No open bracket ${id}.`);
    return;
  }
  const session = await resolveAccount(chatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(chatId, `Run /connect first so I can register your wallet for bracket ${id}.`);
    return;
  }
  const me = session.data.address.toLowerCase();
  if (reg.players.some((p) => p.address.toLowerCase() === me)) {
    await api.sendMessage(chatId, `You're already in bracket ${id} (${reg.players.length}/${reg.capacity}).`);
    return;
  }
  if (reg.players.length >= reg.capacity) {
    await api.sendMessage(chatId, `Bracket ${id} is already full.`);
    return;
  }
  const name = session.data.username && session.data.username !== "unknown" ? session.data.username : undefined;
  reg.players.push({ address: session.data.address, name });
  await store.saveRegistration(reg);
  await api.sendMessage(chatId, `✅ You're in bracket ${id} (${reg.players.length}/${reg.capacity}).`);
  await updateCard(api, reg);

  if (reg.players.length >= reg.capacity) {
    await deployFromRegistration(api, config, store, reg);
  }
}

/**
 * Handle a tap on the public "Join" button. The callback's `fromId` is the
 * player's Telegram user id, which equals their private-chat id — so we can
 * resolve their /connect session and join them without them typing anything.
 * Feedback is a private toast; the public card is edited in place.
 */
export async function joinViaButton(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  callbackQueryId: string,
  fromId: number | undefined,
  id: string,
): Promise<void> {
  if (fromId === undefined) {
    await api.answerCallback(callbackQueryId, "Couldn't identify you — try /bracket_join in a DM.", true);
    return;
  }
  const reg = await store.getRegistration(id);
  if (!reg) {
    // Paid up-front bracket? Pay + enter via the tapper's session.
    const b = await store.get(id);
    if (b?.phase === "filling") {
      const toast = await paidJoin(api, config, store, b, String(fromId));
      await api.answerCallback(callbackQueryId, toast, true);
      return;
    }
    await api.answerCallback(callbackQueryId, "This bracket is no longer open.", true);
    return;
  }
  if (reg.players.length >= reg.capacity) {
    await api.answerCallback(callbackQueryId, "Sorry — it just filled up.", true);
    return;
  }
  const session = await resolveAccount(String(fromId), reg.chain, config);
  if (!session.ok) {
    await api.answerCallback(
      callbackQueryId,
      `DM me first: open @ the bot, run /connect, then tap Join.`,
      true,
    );
    return;
  }
  const me = session.data.address.toLowerCase();
  if (reg.players.some((p) => p.address.toLowerCase() === me)) {
    await api.answerCallback(callbackQueryId, `You're already in (${reg.players.length}/${reg.capacity}).`);
    return;
  }
  const name = session.data.username && session.data.username !== "unknown" ? session.data.username : undefined;
  reg.players.push({ address: session.data.address, name });
  await store.saveRegistration(reg);
  await api.answerCallback(callbackQueryId, `✅ You're in! (${reg.players.length}/${reg.capacity})`);
  await updateCard(api, reg);
  if (reg.players.length >= reg.capacity) {
    await deployFromRegistration(api, config, store, reg);
  }
}

export async function startNow(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  id: string,
): Promise<void> {
  const reg = await store.getRegistration(id);
  if (!reg) {
    await api.sendMessage(chatId, `No open bracket ${id}.`);
    return;
  }
  if (chatId !== reg.organizerChatId) {
    await api.sendMessage(chatId, `Only the organizer can start bracket ${id}.`);
    return;
  }
  if (!isPow2(reg.players.length)) {
    await api.sendMessage(chatId, `Bracket ${id} has ${reg.players.length} players — need a power of two (2, 4, 8, 16…) to start. Wait for more joins, or /cancel via a new bracket.`);
    return;
  }
  await deployFromRegistration(api, config, store, reg);
}

async function deployFromRegistration(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  reg: BracketRegistration,
): Promise<void> {
  const game: Game = {
    contractAddress: reg.game.contractAddress,
    name: reg.game.name,
    leaderboardAscending: reg.game.leaderboardAscending,
    leaderboardGameMustBeOver: reg.game.leaderboardGameMustBeOver,
  };
  const ok = await deployResolved(api, config, store, {
    organizerChatId: reg.organizerChatId,
    announceChatId: reg.announceChatId,
    chain: reg.chain,
    game,
    settingsId: reg.settingsId,
    length: reg.length,
    prize: reg.prize,
    players: reg.players,
  });
  if (ok) await store.deleteRegistration(reg.id);
}

// ----- deploy (shared) -----

interface DeployParams {
  organizerChatId: string;
  announceChatId: string;
  chain: Chain;
  game: Game;
  settingsId?: number;
  length: { reg: number; game: number; sub: number };
  prize?: { tokenAddress: string; amount: string; label: string };
  players: Player[];
}

async function deployResolved(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  p: DeployParams,
): Promise<boolean> {
  const { chain, organizerChatId, announceChatId } = p;
  const session = await resolveAccount(organizerChatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(organizerChatId, `Can't deploy the bracket — the organizer wallet isn't connected on ${chain}. Run /connect and retry.`);
    return false;
  }
  const budokanAddress = config.budokanAddress ?? CHAINS[chain]?.budokanAddress;
  if (!budokanAddress) {
    await api.sendMessage(organizerChatId, `Internal error: no Budokan address for ${chain}.`);
    return false;
  }

  // Fill in any missing display names from Cartridge (best-effort).
  const players = await withUsernames(p.players);

  const id = `b${Date.now().toString(36)}`;
  const state = createBracket({
    id,
    budokanAddress,
    game: p.game.contractAddress,
    chain: chain as BracketState["chain"],
    settingsId: p.settingsId ?? 0,
    creatorRewardsAddress: session.data.address,
    namePrefix: p.game.name.slice(0, 12),
    scheduleTemplate: {
      registrationStartDelay: 0,
      registrationEndDelay: p.length.reg,
      gameStartDelay: p.length.reg,
      gameEndDelay: p.length.game,
      submissionDuration: p.length.sub,
    },
    leaderboard: {
      ascending: p.game.leaderboardAscending ?? false,
      gameMustBeOver: p.game.leaderboardGameMustBeOver ?? false,
    },
    players,
    gated: true,
    finalPrize: p.prize ? { tokenAddress: p.prize.tokenAddress, amount: p.prize.amount } : undefined,
  });

  const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(chain, config.rpcUrl) });
  await api.sendMessage(organizerChatId, `⏳ Deploying ${bracketRounds(state)} rounds of match tournaments…`);
  try {
    for (let round = 1; round <= bracketRounds(state); round++) {
      for (const { matchId, call } of roundMatchCreateCalls(state, round)) {
        const tx = await session.data.account.execute([call]);
        const receipt = (await rpc.waitForTransaction(tx.transaction_hash)) as {
          events?: Array<{ from_address?: string; keys?: string[] }>;
        };
        const tid = parseTournamentIdFromReceipt(receipt, budokanAddress);
        if (tid === undefined) throw new Error(`Couldn't read tournament id for ${matchId}`);
        attachMatchTournament(state, matchId, tid.toString());
      }
      await store.save({ state, organizerChatId, announceChatId });
    }
    for (const m of state.matches.filter((x) => x.round === 1 && x.tournamentId)) {
      for (const player of [m.playerA, m.playerB]) {
        if (!player) continue;
        await session.data.account.execute(bracketEntryCalls(state, m.id, player.address));
      }
    }
    const prizeCalls = bracketFinalPrizeCalls(state);
    if (prizeCalls.length > 0) await session.data.account.execute(prizeCalls);
  } catch (error) {
    await store.save({ state, organizerChatId, announceChatId }).catch(() => {});
    await api.sendMessage(organizerChatId, `❌ Deploy stopped: ${formatError(error)}\nProgress saved — /brackets shows what's live.`);
    return false;
  }

  await store.save({ state, organizerChatId, announceChatId });
  await api.sendMessage(organizerChatId, `✅ Bracket ${id} deployed. Round 1 is live and players are entered.`);
  await announceTo(api, announceChatId, `🥊 The bracket is on!\n\n${presentation({ state, organizerChatId, announceChatId })}`);
  return true;
}

// ----- paid brackets (deploy up front; pay on tap) -----

const PLACEHOLDER_ADDRESS = "0x0";
const placeholder = (seed: number): Player & { seed: number } => ({ address: PLACEHOLDER_ADDRESS, seed });
const isReal = (p?: { address: string }): boolean => !!p && p.address.toLowerCase() !== PLACEHOLDER_ADDRESS;

/**
 * Deploy a paid bracket's whole gated tree up front with placeholder slots, so
 * a Join tap can pay + enter immediately. Players replace slots in join order.
 */
async function deployPaidUpfront(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  organizerChatId: string,
  announceChatId: string,
  d: Draft,
): Promise<void> {
  const chain = d.chain;
  const session = await resolveAccount(organizerChatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(organizerChatId, `Not connected on ${chain} — run /connect first.`);
    return;
  }
  const budokanAddress = config.budokanAddress ?? CHAINS[chain]?.budokanAddress;
  if (!budokanAddress) {
    await api.sendMessage(organizerChatId, `Internal error: no Budokan address for ${chain}.`);
    return;
  }

  const capacity = d.capacity!;
  const game = d.game!;
  const id = `b${Date.now().toString(36)}`;
  const state = createBracket({
    id,
    budokanAddress,
    game: game.contractAddress,
    chain: chain as BracketState["chain"],
    settingsId: d.settingsId ?? 0,
    creatorRewardsAddress: session.data.address,
    namePrefix: game.name.slice(0, 12),
    scheduleTemplate: {
      registrationStartDelay: 0,
      registrationEndDelay: d.length!.reg,
      gameStartDelay: d.length!.reg,
      gameEndDelay: d.length!.game,
      submissionDuration: d.length!.sub,
    },
    leaderboard: {
      ascending: game.leaderboardAscending ?? false,
      gameMustBeOver: game.leaderboardGameMustBeOver ?? false,
    },
    // Placeholder roster — replaced by real players as they tap Join.
    players: Array.from({ length: capacity }, () => ({ address: PLACEHOLDER_ADDRESS })),
    gated: true,
  });

  const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(chain, config.rpcUrl) });
  await api.sendMessage(organizerChatId, `⏳ Deploying ${bracketRounds(state)} rounds for a ${capacity}-player paid bracket…`);
  try {
    for (let round = 1; round <= bracketRounds(state); round++) {
      for (const { matchId, call } of roundMatchCreateCalls(state, round)) {
        const tx = await session.data.account.execute([call]);
        const receipt = (await rpc.waitForTransaction(tx.transaction_hash)) as {
          events?: Array<{ from_address?: string; keys?: string[] }>;
        };
        const tid = parseTournamentIdFromReceipt(receipt, budokanAddress);
        if (tid === undefined) throw new Error(`Couldn't read tournament id for ${matchId}`);
        attachMatchTournament(state, matchId, tid.toString());
      }
    }
  } catch (error) {
    await api.sendMessage(organizerChatId, `❌ Deploy stopped: ${formatError(error)}`);
    return;
  }

  const b: StoredBracket = {
    state,
    organizerChatId,
    announceChatId,
    paid: {
      tokenAddress: d.entryFee!.tokenAddress,
      fee: d.entryFee!.amount,
      tiersBps: d.tiersBps!,
      label: d.entryFee!.label,
    },
    capacity,
    filled: 0,
    phase: "filling",
  };
  await store.save(b);
  const mid = await api.sendCard(announceChatId, paidCard(b), paidJoinKeyboard(b)).catch(() => undefined);
  if (mid !== undefined) {
    b.cardChatId = announceChatId;
    b.cardMessageId = mid;
    await store.save(b);
  }
  await api.sendMessage(
    organizerChatId,
    `✅ Paid bracket ${id} deployed & open (0/${capacity}). Players tap Join to pay ${d.entryFee!.label} and enter. Round 1 starts at the sign-up deadline (${Math.round(d.length!.reg / 60)}m).`,
  );
}

/**
 * Core of a paid entry: assign the next slot and run `payerChatId`'s session to
 * enter the round-1 match + escrow the fee — one multicall, non-custodial. By
 * default the entry mints to the payer (self-join). Pass `opts.playerAddress`
 * to pay on someone else's behalf (sponsorship): the entry token mints to that
 * address while the payer funds the fee + prize escrow. Returns a toast string.
 */
async function enterPaidSlot(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  b: StoredBracket,
  payerChatId: string,
  opts: { playerAddress?: string; playerName?: string } = {},
): Promise<string> {
  if (b.phase !== "filling" || !b.paid || b.filled === undefined || b.capacity === undefined) {
    return "This bracket isn't open for joins.";
  }
  // Capture so narrowing survives the awaits below.
  const paid = b.paid;
  const sponsoring = !!opts.playerAddress;
  if (b.filled >= b.capacity) return "Sorry — it just filled up.";
  const chain = b.state.chain as Chain;
  const session = await resolveAccount(payerChatId, chain, config);
  if (!session.ok) return "DM me first: open the bot, /connect, then try again.";

  const playerAddress = opts.playerAddress ?? session.data.address;
  const playerName =
    opts.playerName ??
    (session.data.username && session.data.username !== "unknown" ? session.data.username : undefined);
  const addr = playerAddress.toLowerCase();
  if (b.state.matches.some((m) => m.round === 1 && (m.playerA?.address.toLowerCase() === addr || m.playerB?.address.toLowerCase() === addr))) {
    return `${sponsoring ? "That player is" : "You're"} already in (${b.filled}/${b.capacity}).`;
  }

  const seed = b.filled + 1;
  const match = b.state.matches.find((m) => m.round === 1 && (m.playerA?.seed === seed || m.playerB?.seed === seed));
  if (!match) return "No open slot — try again.";
  const player = { address: playerAddress, name: playerName, seed };
  const slotA = match.playerA?.seed === seed;
  if (slotA) match.playerA = player;
  else match.playerB = player;
  b.state.players[seed - 1] = player;

  try {
    await session.data.account.execute([
      ...bracketEntryCalls(b.state, match.id, playerAddress),
      ...bracketFeePrizeCalls(b.state, {
        tokenAddress: paid.tokenAddress,
        fee: paid.fee,
        tiersBps: paid.tiersBps,
      }),
    ]);
  } catch (error) {
    // Roll back the slot so it stays open for a retry.
    if (slotA) match.playerA = placeholder(seed);
    else match.playerB = placeholder(seed);
    b.state.players[seed - 1] = placeholder(seed);
    return `Couldn't ${sponsoring ? "sponsor" : "join"}: ${formatError(error)}`;
  }

  b.filled += 1;
  if (b.filled >= b.capacity) b.phase = "live";
  await store.save(b);
  await updatePaidCard(api, b);
  if (b.phase === "live") {
    return `✅ Paid — ${sponsoring ? "sponsored entry added" : "you're in"}; the bracket is starting!`;
  }
  const who = sponsoring ? `${playerName ?? short(playerAddress)} is in (sponsored)` : "you're in";
  return `✅ Paid ${paid.label} — ${who}! (${b.filled}/${b.capacity})`;
}

/** Tap-to-join a paid bracket: the tapping player pays their own entry. */
async function paidJoin(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  b: StoredBracket,
  joinerChatId: string,
): Promise<string> {
  return enterPaidSlot(api, config, store, b, joinerChatId);
}

/**
 * /bracket_sponsor <id> <address|username> — pay another player's entry into a
 * paid bracket from your own session (run in DM, where your session lives).
 */
export async function sponsorPaid(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  id: string,
  target: string,
): Promise<void> {
  const b = await store.get(id);
  if (!b || b.phase !== "filling" || !b.paid) {
    await api.sendMessage(chatId, `No paid bracket ${id} is open for sponsorship.`);
    return;
  }
  const { players, unresolved } = await resolvePlayers(b.state.chain as Chain, target);
  if (players.length === 0) {
    await api.sendMessage(
      chatId,
      `Couldn't resolve "${target}"${unresolved.length ? ` (${unresolved.join(", ")})` : ""}. Use a 0x address or a Cartridge username.`,
    );
    return;
  }
  const p = players[0]!;
  const toast = await enterPaidSlot(api, config, store, b, chatId, { playerAddress: p.address, playerName: p.name });
  await api.sendMessage(chatId, toast);
}

function paidCard(b: StoredBracket): string {
  const cap = b.capacity ?? 0;
  const filled = b.filled ?? 0;
  const remaining = cap - filled;
  const real = b.state.players.filter(isReal);
  const lines = [
    "━━━━━━━━━━━━━━━━━━",
    `🥊 ${b.state.namePrefix} — 1v1 Bracket`,
    "📊 Registration",
    `👥 Players: ${filled}/${cap}`,
  ];
  if (b.paid) {
    lines.push(`💸 Entry: ${b.paid.label}`);
    lines.push(`📊 Paid places: ${b.paid.tiersBps.map((bp) => `${(bp / 100).toFixed(0)}%`).join(" / ")}`);
  }
  lines.push("", "Registered:");
  if (real.length === 0) lines.push("  (be the first!)");
  else real.forEach((p, i) => lines.push(`  ${i + 1}. ${p.name ?? short(p.address)}`));
  lines.push("");
  if (remaining > 0) {
    lines.push(`🪑 ${remaining} spot${remaining === 1 ? "" : "s"} remaining!`);
    lines.push("🎮 Tap Join — first /connect in a DM with me.");
    lines.push("⏱️ Round 1 starts at the sign-up deadline (empty slots walk over).");
  } else {
    lines.push("🔒 Full — round 1 begins at the sign-up deadline.");
  }
  return lines.join("\n");
}

function paidJoinKeyboard(b: StoredBracket): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  if ((b.filled ?? 0) >= (b.capacity ?? 0)) return undefined;
  return {
    inline_keyboard: [
      [{ text: `🎮 Join — ${b.paid?.label ?? "play"} (${b.filled ?? 0}/${b.capacity ?? 0})`, callback_data: `bjoin:${b.state.id}` }],
      [{ text: `🎁 Sponsor a player`, callback_data: `bspon:${b.state.id}` }],
    ],
  };
}

/** A Sponsor-button tap: point the user to the DM command (it needs a target). */
export async function sponsorViaButton(
  api: TelegramApi,
  callbackQueryId: string,
  id: string,
): Promise<void> {
  await api.answerCallback(
    callbackQueryId,
    `To sponsor a player, DM me:  /bracket_sponsor ${id} <address or Cartridge username>`,
    true,
  );
}

async function updatePaidCard(api: TelegramApi, b: StoredBracket): Promise<void> {
  if (!b.cardChatId || b.cardMessageId === undefined) return;
  await api.editCard(b.cardChatId, b.cardMessageId, paidCard(b), paidJoinKeyboard(b));
}

// ----- advancement (poller) -----

export async function advanceStoredBracket(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  b: StoredBracket,
): Promise<void> {
  // A paid bracket still gathering players isn't running yet — don't advance it.
  if (b.phase === "filling") return;
  const chain = b.state.chain as Chain;
  const session = await resolveAccount(b.organizerChatId, chain, config);
  if (!session.ok) return;

  const before = bracketSummary(b.state);
  const read = buildReader(config, chain);
  const { state } = await advanceBracket(b.state, read);
  b.state = state;

  const entered = new Set<string>(b.entered ?? []);
  for (const m of state.matches) {
    if (m.round === 1 || !m.tournamentId || entered.has(m.id)) continue;
    if (!m.playerA || !m.playerB) continue;
    try {
      for (const player of [m.playerA, m.playerB]) {
        await session.data.account.execute(bracketEntryCalls(state, m.id, player.address));
      }
      entered.add(m.id);
    } catch (error) {
      console.error(`bracket ${state.id} enter ${m.id} failed:`, formatError(error));
    }
  }
  b.entered = [...entered];
  await store.save(b);

  if (bracketSummary(b.state) !== before) {
    const header = b.state.status === "complete" ? "🏆 Bracket complete!" : "📣 Bracket update";
    await announceTo(api, b.announceChatId, `${header}\n\n${presentation(b)}`);
  }
}

function buildReader(config: Config, chain: Chain): MatchReader {
  const client = createBudokanClient({
    chain,
    ...(config.apiUrl ? { apiBaseUrl: config.apiUrl } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.budokanAddress ? { budokanAddress: config.budokanAddress } : {}),
    ...(config.viewerAddress ? { viewerAddress: config.viewerAddress } : {}),
  } as Parameters<typeof createBudokanClient>[0]);
  const denshokan = createDenshokanClient({ chain });

  return async (tournamentId: string) => {
    const tournament = await client.getTournament(tournamentId);
    const now = Math.floor(Date.now() / 1000);
    const gameEnd = Number(tournament?.gameEndTime ?? 0);
    if (!(gameEnd > 0 && now >= gameEnd)) return { finished: false, ranking: [] };

    const lb = await client.getTournamentLeaderboard(tournamentId);
    const ranking: Array<{ address: string; position: number; tokenId?: string }> = [];
    for (const e of lb) {
      let owner = "";
      try {
        owner = (await denshokan.getToken(e.tokenId)).owner ?? "";
      } catch {
        // unknown owner — skip
      }
      if (owner) ranking.push({ address: owner, position: e.position, tokenId: e.tokenId });
    }
    return { finished: true, ranking };
  };
}

// ----- listing + presentation -----

export async function list(
  api: TelegramApi,
  store: BracketStore,
  chatId: string,
  chain: Chain,
): Promise<void> {
  const deployed = (await store.all()).filter((b) => (b.state.chain as Chain) === chain);
  const open = (await store.allRegistrations()).filter((r) => r.chain === chain);
  if (deployed.length === 0 && open.length === 0) {
    await api.sendMessage(chatId, `No brackets on ${chain}. Create one with /bracket.`);
    return;
  }
  const lines = [`🥊 Brackets on ${chain}:`, ""];
  for (const r of open) {
    lines.push(`  • ${r.id} [registering ${r.players.length}/${r.capacity}] · join: /bracket_join ${r.id}`);
  }
  for (const b of deployed) {
    const champ = b.state.champion ? ` — 🏆 ${b.state.champion.name ?? short(b.state.champion.address)}` : "";
    lines.push(`  • ${b.state.id} [${b.state.status}] · ${b.state.players.length} players${champ} · /bracket_view ${b.state.id}`);
  }
  await api.sendMessage(chatId, lines.join("\n"));
}

export async function view(
  api: TelegramApi,
  store: BracketStore,
  chatId: string,
  id: string,
): Promise<void> {
  const b = await store.get(id);
  if (b) {
    if (b.phase === "filling") await api.sendCard(chatId, paidCard(b), paidJoinKeyboard(b));
    else await api.sendMessage(chatId, presentation(b));
    return;
  }
  const reg = await store.getRegistration(id);
  if (reg) {
    await api.sendCard(chatId, registrationCard(reg), joinKeyboard(reg));
    return;
  }
  await api.sendMessage(chatId, `No bracket ${id}.`);
}

async function announceTo(api: TelegramApi, chatId: string, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, text);
  } catch (error) {
    console.error("bracket announce failed:", formatError(error));
  }
}

/** The live, public registration card (edited in place as players join). */
function registrationCard(reg: BracketRegistration): string {
  const remaining = reg.capacity - reg.players.length;
  const lines = [
    "━━━━━━━━━━━━━━━━━━",
    `🥊 ${reg.game.name} — 1v1 Bracket`,
    "📊 Registration",
    `👥 Players: ${reg.players.length}/${reg.capacity}`,
  ];
  if (reg.prize) lines.push(`🏆 Champion prize: ${reg.prize.label}`);
  lines.push("", "Registered:");
  if (reg.players.length === 0) {
    lines.push("  (be the first!)");
  } else {
    reg.players.forEach((p, i) => lines.push(`  ${i + 1}. ${p.name ?? short(p.address)}`));
  }
  lines.push("");
  if (remaining > 0) {
    lines.push(`🪑 ${remaining} spot${remaining === 1 ? "" : "s"} remaining!`);
    lines.push("🎮 Tap Join below — first /connect in a DM with me.");
  } else {
    lines.push("🚀 Full — starting the bracket!");
  }
  return lines.join("\n");
}

/** Inline keyboard with the Join button (omitted once full). */
function joinKeyboard(
  reg: BracketRegistration,
): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  if (reg.players.length >= reg.capacity) return undefined;
  return {
    inline_keyboard: [
      [{ text: `🎮 Join (${reg.players.length}/${reg.capacity})`, callback_data: `bjoin:${reg.id}` }],
    ],
  };
}

/** Re-render the public registration card in place after a roster change. */
async function updateCard(api: TelegramApi, reg: BracketRegistration): Promise<void> {
  if (!reg.cardChatId || reg.cardMessageId === undefined) return;
  await api.editCard(reg.cardChatId, reg.cardMessageId, registrationCard(reg), joinKeyboard(reg));
}

function presentation(b: StoredBracket): string {
  const s = b.state;
  const chain = s.chain as Chain;
  const lines = [bracketSummary(s)];
  const live = s.matches.filter((m) => m.status === "live" && m.tournamentId);
  if (live.length > 0) {
    lines.push("", "▶ Live matches:");
    for (const m of live) {
      lines.push(`  R${m.round}-${m.indexInRound + 1}: ${tournamentPageUrl(chain, m.tournamentId!)}`);
    }
  }
  return lines.join("\n");
}

// ----- helpers -----

function pastePrompt(who: string): string {
  return [
    `Paste ${who} — one per line, each a 0x address or a Cartridge username:`,
    "```",
    "shinobi",
    "0x456… bob",
    "```",
    "Power-of-two final size (2, 4, 8, 16…). /cancel to abort.",
  ].join("\n");
}

async function sendLengthPrompt(api: TelegramApi, chatId: string): Promise<void> {
  const lines = ["Pick a match length:", ""];
  LENGTH_PRESETS.forEach((p, i) => lines.push(`  ${i + 1}. ${p.label}`));
  lines.push("", "Reply with a number. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

/** Numbered token picker shared by the entry-fee and sponsored-prize steps. */
async function sendTokenList(
  api: TelegramApi,
  chain: Chain,
  chatId: string,
  header: string,
  zeroLabel: string,
): Promise<void> {
  const tokens = tokensForChain(chain);
  const lines = [header, ""];
  tokens.forEach((tk, i) => lines.push(`  ${i + 1}. ${tk.symbol}`));
  lines.push(`  0. ${zeroLabel}`);
  lines.push("", "Reply with a number. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

async function sendFeeTokenPrompt(api: TelegramApi, chain: Chain, chatId: string): Promise<void> {
  await sendTokenList(api, chain, chatId, "💸 Entry fee — pick a token:", "No entry fee (free bracket)");
}

async function sendFeeSplitPrompt(api: TelegramApi, chatId: string): Promise<void> {
  const lines = ["🏆 Prize split — how the pool pays out:", ""];
  FEE_SPLITS.forEach((s, i) => lines.push(`  ${i + 1}. ${s.label}`));
  lines.push(`  ${FEE_SPLITS.length + 1}. Custom — enter percentages`);
  lines.push("", "Reply with a number. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

async function sendModePrompt(api: TelegramApi, d: Draft, chatId: string): Promise<void> {
  d.step = "mode";
  const tag = d.settingsName ? ` — ${d.settingsName}` : "";
  const lines = [`🎮 ${d.game!.name}${tag}. How should players join?`, ""];
  MODES.forEach((m, i) => lines.push(`  ${i + 1}. ${m.label}`));
  lines.push("", "Reply with a number. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

/** Fetch + show one page of the game's settings (mirrors /create). */
async function renderBracketSettings(api: TelegramApi, d: Draft, chatId: string, offset: number): Promise<void> {
  d.step = "settings";
  let page: SettingsPage;
  try {
    page = await fetchSettings(d.chain, d.game!.contractAddress, { limit: 5, offset });
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't load settings: ${formatError(error)}\nReply 'retry', or 'skip' to use ID 0.`);
    d.settingsPage = undefined;
    return;
  }
  d.settingsPage = page;
  if (page.data.length === 0) {
    d.settingsId = 0;
    d.settingsName = "(default)";
    await api.sendMessage(chatId, "No settings registered for this game — using settings ID 0.");
    await sendModePrompt(api, d, chatId);
    return;
  }
  const pages = Math.max(1, Math.ceil(page.total / page.limit));
  const lines = [
    `⚙️ Settings for ${d.game!.name} (page ${Math.floor(offset / page.limit) + 1} of ${pages}):`,
    "",
    ...page.data.map((s, i) => `  ${i + 1}. ID ${s.id}${s.name ? ` — ${s.name}` : ""}`),
    "",
    "Reply with a number, 'next' / 'prev', or 'skip' for ID 0. /cancel to abort.",
  ];
  await api.sendMessage(chatId, lines.join("\n"));
}

async function handleBracketSettings(api: TelegramApi, d: Draft, chatId: string, input: string): Promise<void> {
  const lower = input.toLowerCase();
  if (lower === "skip") {
    d.settingsId = 0;
    d.settingsName = "(default)";
    await sendModePrompt(api, d, chatId);
    return;
  }
  if (lower === "retry") {
    await renderBracketSettings(api, d, chatId, d.settingsPage?.offset ?? 0);
    return;
  }
  const page = d.settingsPage;
  if (!page) {
    await renderBracketSettings(api, d, chatId, 0);
    return;
  }
  if (lower === "next") {
    const nextOffset = page.offset + page.limit;
    if (nextOffset >= page.total) {
      await api.sendMessage(chatId, "Already on the last page.");
      return;
    }
    await renderBracketSettings(api, d, chatId, nextOffset);
    return;
  }
  if (lower === "prev") {
    if (page.offset === 0) {
      await api.sendMessage(chatId, "Already on the first page.");
      return;
    }
    await renderBracketSettings(api, d, chatId, Math.max(0, page.offset - page.limit));
    return;
  }
  const n = Number(input);
  if (!/^\d+$/.test(input) || n < 1 || n > page.data.length) {
    await api.sendMessage(chatId, `Reply 1–${page.data.length}, 'next', 'prev', or 'skip'.`);
    return;
  }
  const chosen = page.data[n - 1]!;
  d.settingsId = chosen.id;
  d.settingsName = chosen.name ?? `ID ${chosen.id}`;
  await sendModePrompt(api, d, chatId);
}

function confirmText(d: Draft): string {
  const roster =
    d.mode === "open"
      ? `open, capacity ${d.capacity}`
      : d.mode === "mix"
        ? `mix — ${d.players!.length} seeded, capacity ${d.capacity}`
        : `closed — ${d.players!.length} players`;
  return [
    "🧾 Confirm bracket:",
    `  • Game: ${d.game!.name}`,
    `  • Settings: ${d.settingsName ?? "(default)"}`,
    `  • Roster: ${roster}`,
    `  • Match length: ${d.length!.label}`,
    `  • Champion prize: ${d.prize ? d.prize.label : "none"}`,
    ...(d.entryFee
      ? [`  • Entry fee: ${d.entryFee.label} → places ${(d.tiersBps ?? []).map((b) => `${(b / 100).toFixed(0)}%`).join("/")}`]
      : []),
    "",
    d.mode === "open" && d.entryFee
      ? "Deploys the gated tree now; players tap Join to pay & enter. Round 1 starts at the sign-up deadline — any empty slots walk over."
      : d.mode === "closed"
        ? "Deploys the gated tree now and enters round 1 for the players."
        : "Opens registration; deploys automatically when it fills.",
    "",
    "Reply 'yes', or /cancel.",
  ].join("\n");
}

/** Parse pasted lines into players, resolving Cartridge usernames → addresses. */
async function resolvePlayers(
  _chain: Chain,
  text: string,
): Promise<{ players: Player[]; unresolved: string[] }> {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const usernames: string[] = [];
  const parsed: Array<{ address?: string; username?: string; name?: string }> = [];
  for (const line of lines) {
    const [first, ...rest] = line.split(/\s+/);
    if (!first) continue;
    if (/^0x[0-9a-fA-F]+$/.test(first)) {
      parsed.push({ address: first, name: rest.join(" ") || undefined });
    } else {
      usernames.push(first);
      parsed.push({ username: first });
    }
  }
  const map =
    usernames.length > 0
      ? await lookupUsernamesToAddresses(usernames).catch(() => new Map<string, string>())
      : new Map<string, string>();
  const players: Player[] = [];
  const unresolved: string[] = [];
  for (const p of parsed) {
    if (p.address) {
      players.push({ address: p.address, name: p.name });
    } else {
      const addr = map.get(p.username!.toLowerCase());
      if (!addr) unresolved.push(p.username!);
      else players.push({ address: addr, name: p.username });
    }
  }
  return { players, unresolved };
}

/** Fill missing display names via a reverse Cartridge lookup (best-effort). */
async function withUsernames(players: Player[]): Promise<Player[]> {
  const missing = players.filter((p) => !p.name).map((p) => p.address);
  if (missing.length === 0) return players;
  const map = await lookupAddressesToUsernames(missing).catch(() => new Map<string, string>());
  return players.map((p) => (p.name ? p : { ...p, name: map.get(num.toHex(p.address)) }));
}

// Cartridge username ↔ controller-address lookup (https://api.cartridge.gg/lookup).
// POST { usernames? , addresses? } → { results: [{ username, addresses[] }] }.
interface CartridgeLookupResult {
  username: string;
  addresses: string[];
}

async function cartridgeLookup(body: {
  usernames?: string[];
  addresses?: string[];
}): Promise<CartridgeLookupResult[]> {
  if (!body.usernames?.length && !body.addresses?.length) return [];
  const res = await fetch("https://api.cartridge.gg/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Cartridge lookup failed: ${res.status}`);
  const data = (await res.json()) as { results?: CartridgeLookupResult[] };
  return data.results ?? [];
}

/** username (lowercased) → controller address. */
async function lookupUsernamesToAddresses(usernames: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await cartridgeLookup({ usernames })) {
    if (r.addresses?.[0]) out.set(r.username.toLowerCase(), r.addresses[0]);
  }
  return out;
}

/** num.toHex(address) → username. */
async function lookupAddressesToUsernames(addresses: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await cartridgeLookup({ addresses })) {
    if (r.addresses?.[0]) out.set(num.toHex(r.addresses[0]), r.username);
  }
  return out;
}

function toRawAmount(human: string, decimals: number): string {
  const [whole, frac = ""] = human.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0")).toString();
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
