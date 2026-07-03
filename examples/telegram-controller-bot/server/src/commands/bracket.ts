// /bracket — organizer flow to create + run an off-chain 1v1 single-elim
// bracket over Budokan tournaments, with on-chain gating (each round's entry
// requires having won the feeder match). See budokan-sdk `src/brackets`.
//
// Two rosters:
//   - closed: organizer pastes every player up front (addresses or Cartridge
//     usernames) → deploys immediately, enters everyone.
//   - open:   organizer sets a capacity + optional prize pool (sponsor seed
//     and/or per-entry fee); the tree deploys up front (seed escrowed before
//     joins), players tap Join to enter their slot. Round 1 starts at the
//     sign-up deadline (empty slots walk over). To add a specific player,
//     /bracket_sponsor them in.
//
// The whole tree is deployed up front; the bot enters round-1 players (closed)
// or players enter themselves on Join (open), and as rounds resolve the poller
// (advanceStoredBracket) enters winners into the next gated match.

import {
  CHAINS,
  createBudokanClient,
  createBracket,
  advanceBracket,
  attachMatchTournament,
  attachRoundOneTree,
  bracketEntryCalls,
  bracketFeePrizeCalls,
  bracketRounds,
  bracketSummary,
  buildRegisterAllowlistTreeCall,
  getAllowlistProof,
  parseAllowlistTreeId,
  parseTournamentIdFromReceipt,
  roundMatchCreateCalls,
  storeAllowlistTree,
  tournamentPageUrl,
  type BracketState,
  type MatchReader,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient } from "@provable-games/denshokan-sdk";
import { Account, num, RpcProvider } from "starknet";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import { TelegramApi, type InlineKeyboardButton } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { keychainSafeRpcUrl } from "../cartridge-link.ts";
import { gamesForChain, type Game } from "../catalog/games.ts";
import { tokensForChain, type Erc20Token } from "../catalog/tokens.ts";
import {
  fetchSettings,
  fetchSetting,
  formatSettingsDetails,
  type SettingsPage,
  type GameSettingDetails,
} from "../catalog/settings.ts";
import { formatError } from "../format-error.ts";
import { BracketStore, type StoredBracket } from "../bracket-store.ts";

type Player = { address: string; name?: string };

// Per-match schedule presets (durations in seconds).
// Budokan enforces 1-hour minimums on each phase (MIN_REGISTRATION_PERIOD,
// MIN_TOURNAMENT_LENGTH, MIN_SUBMISSION_PERIOD = 3600s), so every preset must
// keep reg/game/sub ≥ 3600 or create_tournament reverts in schedule validation.
const LENGTH_PRESETS = [
  { label: "Quick — 1h matches, 1h to submit", reg: 3600, game: 3600, sub: 3600 },
  { label: "Standard — 6h matches, 1h to submit", reg: 3600, game: 21600, sub: 3600 },
  { label: "Daily — 24h matches, 6h to submit", reg: 21600, game: 86400, sub: 21600 },
] as const;

// When round 1 begins, measured from deploy — also the sign-up window (players
// can join/enter until then). Budokan's MIN_REGISTRATION_PERIOD is 1h, the floor.
const START_PRESETS = [
  { label: "In 1 hour (soonest)", sec: 3600 },
  { label: "In 3 hours", sec: 10800 },
  { label: "In 6 hours", sec: 21600 },
  { label: "In 12 hours", sec: 43200 },
  { label: "In 24 hours", sec: 86400 },
] as const;
const MIN_START_SEC = 3600;

const MODES = [
  { key: "closed", label: "Closed — I'll paste all players now" },
  { key: "open", label: "Open — players join until full, then it starts" },
] as const;

const CAPACITIES = [4, 8, 16, 32] as const;

interface Draft {
  step:
    | "game"
    | "settings"
    | "name"
    | "description"
    | "mode"
    | "capacity"
    | "players"
    | "length"
    | "start"
    | "roundSettings"
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
  /** Flat settings list for the per-round picker (numbered, no raw ids shown). */
  settingsList?: GameSettingDetails[];
  /** Bracket title; prefixes each match name ("<name> R1-1") and titles the card. */
  namePrefix?: string;
  /** Optional per-round settings (round 1 → final); falls back to settingsId. */
  roundSettingsIds?: number[];
  /** Organizer blurb shown on the card + set as each match's on-chain description. */
  description?: string;
  mode?: (typeof MODES)[number]["key"];
  capacity?: number;
  players?: Player[]; // closed: everyone; open: [] (all join)
  length?: (typeof LENGTH_PRESETS)[number];
  /** Seconds from deploy until round 1 starts (= the sign-up window). ≥ 1h. */
  startDelaySec?: number;
  // Open mode only: players pay this entry fee on join (≤ the ~$10 session cap);
  // it escrows into placement prizes per tiersBps. Collected over the
  // feeToken → feeAmount → feeSplit sub-flow. Larger/organizer prizes are added
  // on budokan.gg, not in-session.
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
// chatId -> bracketId, for the DM sponsor flow (started via a channel deeplink).
const sponsorPending = new Map<string, string>();

export function isPending(chatId: string): boolean {
  return drafts.has(chatId) || sponsorPending.has(chatId);
}
export function cancel(chatId: string): boolean {
  const had = drafts.delete(chatId);
  return sponsorPending.delete(chatId) || had;
}

// The bot's own @username, set at startup (via getMe). Used to build the Sponsor
// deeplink so the channel button carries the bracket id — no long id to type.
let botUsername = "";
export function setBotUsername(u: string): void {
  botUsername = u;
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
  // Sponsor flow (opened from a channel deeplink): the reply is the target player.
  const sponsorId = sponsorPending.get(chatId);
  if (sponsorId !== undefined) {
    sponsorPending.delete(chatId);
    await sponsorPaid(api, config, store, chatId, sponsorId, text.trim());
    return;
  }
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

  if (d.step === "name") {
    // ≤24 chars so "<name> R1-1" stays within the 31-char on-chain name limit.
    if (!/^(skip|none|no)$/i.test(t)) d.namePrefix = t.slice(0, 24);
    await sendDescriptionPrompt(api, d, chatId);
    return;
  }

  if (d.step === "description") {
    if (!/^(skip|none|no)$/i.test(t)) d.description = t.slice(0, 200);
    await sendModePrompt(api, d, chatId);
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
    // open: no pre-seeds — everyone joins.
    d.players = [];
    d.step = "length";
    await sendLengthPrompt(api, chatId);
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
    // closed: the pasted roster is the whole bracket (power of two).
    if (!isPow2(players.length)) {
      await api.sendMessage(chatId, `Got ${players.length}. A closed bracket needs a power of two (2, 4, 8, 16…). Resend, or /cancel.`);
      return;
    }
    d.capacity = players.length;
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
    await sendStartPrompt(api, d, chatId);
    return;
  }

  if (d.step === "start") {
    const delay = parseStartDelay(t);
    if (delay === null) {
      await api.sendMessage(
        chatId,
        `Reply 1–${START_PRESETS.length}, or a custom time like "in 2 days", "in 90 minutes", or "2026-07-05 18:00" (UTC). Minimum 1 hour out.`,
      );
      return;
    }
    d.startDelaySec = delay;
    await sendRoundSettingsPrompt(api, d, chatId);
    return;
  }

  if (d.step === "roundSettings") {
    const rounds = Math.log2(d.capacity ?? d.players?.length ?? 2);
    const list = d.settingsList ?? [];
    if (/^(skip|none|no)$/i.test(t)) {
      await sendFundingPrompt(api, d, chatId);
      return;
    }
    const inspectMatch = /^(\d+)\?$/.exec(t.trim());
    if (inspectMatch) {
      const idx = Number(inspectMatch[1]);
      if (idx >= 1 && idx <= list.length) {
        await api.sendMessage(chatId, `${formatSettingsDetails(list[idx - 1]!)}\n\nGive ${rounds} numbers (round 1 → final), or 'skip'.`);
      } else {
        await api.sendMessage(chatId, `No setting ${idx}. Reply 1–${list.length}.`);
      }
      return;
    }
    const picks = t.split(/[\s,]+/).filter(Boolean).map(Number);
    if (picks.length !== rounds || picks.some((x) => !Number.isInteger(x) || x < 1 || x > list.length)) {
      await api.sendMessage(chatId, `Give exactly ${rounds} numbers (1–${list.length}, round 1 → final), comma-separated, or 'skip'.`);
      return;
    }
    d.roundSettingsIds = picks.map((p) => list[p - 1]!.id);
    await sendFundingPrompt(api, d, chatId);
    return;
  }

  if (d.step === "feeToken") {
    if (/^(0|skip|none|no)$/i.test(t)) {
      // No per-entry fee → a free bracket. Organizers add any prize pool on
      // budokan.gg (prize funding is deferred there, not done in-session).
      d.step = "confirm";
      await api.sendMessage(chatId, confirmText(d));
      return;
    }
    const tokens = spendableTokens(d.chain);
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > tokens.length) {
      await api.sendMessage(chatId, `Reply 1–${tokens.length} to pick a token, 0 for no entry fee, or /cancel.`);
      return;
    }
    d.feeToken = tokens[n - 1];
    d.step = "feeAmount";
    await api.sendMessage(chatId, `💸 Entry fee amount in ${d.feeToken!.symbol}? (each entrant adds this to the pool) /cancel to abort.`);
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
    // Only set an entry fee if one was actually chosen (seed-only skips it).
    if (d.feeAmountRaw && d.feeToken) {
      d.entryFee = { tokenAddress: d.feeToken.address, amount: d.feeAmountRaw, label: d.feeAmountLabel! };
    }
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
    if (d.feeAmountRaw && d.feeToken) {
      d.entryFee = { tokenAddress: d.feeToken.address, amount: d.feeAmountRaw, label: d.feeAmountLabel! };
    }
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
    // Announce target: the channel set via /channel wins, then the env
    // var, then the organizer's DM.
    const announceChatId = (await store.getAnnounceChannel()) ?? config.bracketChannelId ?? chatId;

    if (d.mode === "closed") {
      await deployResolved(api, config, store, {
        organizerChatId: chatId,
        announceChatId,
        chain: d.chain,
        game: d.game!,
        settingsId: d.settingsId,
        roundSettingsIds: d.roundSettingsIds,
        namePrefix: d.namePrefix,
        description: d.description,
        length: d.length!,
        startDelaySec: d.startDelaySec!,
        players: d.players!,
      });
      return;
    }

    // Open brackets deploy the tree up front (no register-then-fill): any seed
    // is escrowed before anyone joins (trustless), and players tap Join to enter
    // — paying a fee if set, free otherwise. Tournaments are on-chain at
    // creation, so there's never a "where are my tournaments?" gap.
    await deployPaidUpfront(api, config, store, chatId, announceChatId, d);
    return;
  }
}

/**
 * Set the chat this command is run in as the bracket announce channel — run
 * /channel inside the public group. Replaces needing BRACKET_CHANNEL_ID.
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

// ----- join (open brackets are deployed up front; players enter their slot) -----

export async function join(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  _chain: Chain,
  id: string,
): Promise<void> {
  const b = await store.get(id);
  if (b?.phase === "filling") {
    const toast = await paidJoin(api, config, store, b, chatId);
    await api.sendMessage(chatId, toast);
    return;
  }
  await api.sendMessage(chatId, `No open bracket ${id} to join.`);
}

/**
 * Handle a tap on the public "Join" button. The callback's `fromId` is the
 * player's Telegram user id, which equals their private-chat id — so we resolve
 * their /connect session and enter them without them typing anything. Feedback
 * is a private toast; the public card is edited in place.
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
    await api.answerCallback(callbackQueryId, "Couldn't identify you — try /join in a DM.", true);
    return;
  }
  const b = await store.get(id);
  if (b?.phase === "filling") {
    const toast = await paidJoin(api, config, store, b, String(fromId));
    await api.answerCallback(callbackQueryId, toast, true);
    return;
  }
  await api.answerCallback(callbackQueryId, "This bracket is no longer open.", true);
}

// ----- deploy (shared) -----

interface DeployParams {
  organizerChatId: string;
  announceChatId: string;
  chain: Chain;
  game: Game;
  settingsId?: number;
  roundSettingsIds?: number[];
  namePrefix?: string;
  description?: string;
  length: { reg: number; game: number; sub: number };
  startDelaySec: number;
  players: Player[];
}

/** Signs + submits calls (the organizer's Cartridge session or a raw Account). */
type BracketCall = { contractAddress: string; entrypoint: string; calldata: string[] };
type Executor = { execute: (calls: BracketCall[]) => Promise<{ transaction_hash: string }> };

/**
 * Phase 3/4b — register a per-match merkle allowlist for round 1 so only each
 * match's assigned players can enter it (closing the round-1 client bypass).
 * One on-chain `create_tree` per match (batching is a future optimization),
 * stored in the merkle API, then attached to the state. No-op unless
 * `config.bracketMerkleGating` is on. MUST run before the round-1
 * create_tournament calls — they embed the tree id in the entry requirement.
 */
async function registerRoundOneAllowlists(
  state: BracketState,
  executor: Executor,
  rpc: RpcProvider,
  config: Config,
): Promise<void> {
  if (!config.bracketMerkleGating) return;
  const chain = state.chain;
  const apiUrl = config.merkleApiUrl;
  for (const m of state.matches.filter((x) => x.round === 1)) {
    const addresses = [m.playerA, m.playerB]
      .filter((pl): pl is NonNullable<typeof pl> => isReal(pl))
      .map((pl) => pl.address);
    if (addresses.length === 0) continue; // fully-placeholder slot (open, pre-fill)
    const { call, entries } = buildRegisterAllowlistTreeCall({
      chain,
      addresses,
      ...(apiUrl ? { apiUrl } : {}),
    });
    const tx = await executor.execute([call]);
    const receipt = (await rpc.waitForTransaction(tx.transaction_hash)) as { events?: unknown[] };
    const treeId = parseAllowlistTreeId({ chain, events: receipt.events ?? [], ...(apiUrl ? { apiUrl } : {}) });
    if (treeId == null) throw new Error(`Couldn't read merkle tree id for ${m.id}`);
    await storeAllowlistTree({
      chain,
      treeId,
      name: `${state.namePrefix} ${m.id}`.slice(0, 60),
      description: `Bracket ${state.id} round-1 allowlist (${m.id})`,
      entries,
      ...(apiUrl ? { apiUrl } : {}),
    });
    attachRoundOneTree(state, m.id, treeId);
  }
}

/** The round-1 merkle proof for a player, or undefined when the match is ungated. */
async function roundOneProof(
  state: BracketState,
  matchId: string,
  address: string,
  config: Config,
): Promise<string[] | undefined> {
  const treeId = state.roundOneTreeIds?.[matchId];
  if (treeId === undefined) return undefined;
  return getAllowlistProof({
    chain: state.chain,
    treeId,
    address,
    ...(config.merkleApiUrl ? { apiUrl: config.merkleApiUrl } : {}),
  });
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
    namePrefix: p.namePrefix ?? p.game.name.slice(0, 12),
    ...(p.roundSettingsIds ? { roundSettingsIds: p.roundSettingsIds } : {}),
    ...(p.description ? { description: p.description } : {}),
    scheduleTemplate: {
      registrationStartDelay: 0,
      registrationEndDelay: p.startDelaySec,
      gameStartDelay: p.startDelaySec,
      gameEndDelay: p.length.game,
      submissionDuration: p.length.sub,
    },
    leaderboard: {
      ascending: p.game.leaderboardAscending ?? false,
      gameMustBeOver: p.game.leaderboardGameMustBeOver ?? false,
    },
    players,
    gated: true,
    // Sponsored prize is escrowed below via bracketFeePrizeCalls (supports a
    // placement split), not the single-position finalPrize path.
  });

  const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(chain, config.rpcUrl) });
  await api.sendMessage(organizerChatId, `⏳ Deploying ${bracketRounds(state)} rounds of match tournaments…`);
  try {
    // Phase 3: gate round 1 on a per-match allowlist (no-op unless enabled).
    // Must precede the round-1 creates so their entry requirement carries the id.
    if (config.bracketMerkleGating) {
      await api.sendMessage(organizerChatId, `🔒 Registering round-1 allowlists…`);
      await registerRoundOneAllowlists(state, session.data.account, rpc, config);
    }
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
    // Enter (= mint the game token for) every round-1 player in ONE multicall,
    // instead of a separate tx per player. Merkle-gated matches attach the
    // player's allowlist proof (fetched from the merkle service).
    const entryCalls: ReturnType<typeof bracketEntryCalls> = [];
    for (const m of state.matches.filter((x) => x.round === 1 && x.tournamentId)) {
      for (const player of [m.playerA, m.playerB]) {
        if (!isReal(player)) continue;
        const proof = await roundOneProof(state, m.id, player!.address, config);
        entryCalls.push(...bracketEntryCalls(state, m.id, player!.address, proof));
      }
    }
    if (entryCalls.length > 0) {
      // Wait for acceptance (like the create/register txs) so a reverted entry —
      // e.g. a merkle proof/qualifier mismatch — surfaces as a deploy failure
      // instead of the bot reporting "players entered" prematurely.
      const entryTx = await session.data.account.execute(entryCalls);
      await rpc.waitForTransaction(entryTx.transaction_hash);
    }
  } catch (error) {
    await store.save({ state, organizerChatId, announceChatId }).catch(() => {});
    await api.sendMessage(organizerChatId, `❌ Deploy stopped: ${formatError(error)}\nProgress saved — /tournaments shows what's live.`);
    return false;
  }

  await store.save({ state, organizerChatId, announceChatId });
  const prizeButton = addPrizeButton(state);
  await api.sendMessage(
    organizerChatId,
    `✅ Bracket ${id} deployed, players entered. Round 1 starts ${startSummary(p.startDelaySec)}.\n\n${addPrizeHint(state)}`,
    prizeButton ? { replyMarkup: prizeButton } : {},
  );
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
    namePrefix: d.namePrefix ?? game.name.slice(0, 12),
    ...(d.roundSettingsIds ? { roundSettingsIds: d.roundSettingsIds } : {}),
    ...(d.description ? { description: d.description } : {}),
    scheduleTemplate: {
      registrationStartDelay: 0,
      registrationEndDelay: d.startDelaySec!,
      gameStartDelay: d.startDelaySec!,
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

  const tiersBps = d.tiersBps ?? [10000];
  const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(chain, config.rpcUrl) });
  await api.sendMessage(organizerChatId, `⏳ Deploying ${bracketRounds(state)} rounds for a ${capacity}-player bracket…`);
  let step = "starting";
  try {
    for (let round = 1; round <= bracketRounds(state); round++) {
      for (const { matchId, call } of roundMatchCreateCalls(state, round)) {
        step = `creating match ${matchId} (round ${round}${round > 1 ? ", gated" : ""})`;
        console.error(`[bracket ${id}] ${step}: create_tournament settingsId=${d.settingsId ?? 0}`);
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
    await api.sendMessage(organizerChatId, `❌ Deploy stopped while ${step}: ${formatError(error)}`);
    return;
  }

  const b: StoredBracket = {
    state,
    organizerChatId,
    announceChatId,
    ...(d.description ? { description: d.description } : {}),
    paid: d.entryFee
      ? { tokenAddress: d.entryFee.tokenAddress, fee: d.entryFee.amount, tiersBps, label: d.entryFee.label }
      : undefined,
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
  const joinLine = d.entryFee
    ? `Players tap Join to pay ${d.entryFee.label} (adds to the pool) and enter.`
    : `Players tap Join to enter (free).`;
  const prizeButton = addPrizeButton(b.state);
  await api.sendMessage(
    organizerChatId,
    `✅ Bracket ${id} deployed & open (0/${capacity}). ${joinLine} Round 1 starts ${startSummary(d.startDelaySec!)}.\n\n${addPrizeHint(b.state)}`,
    prizeButton ? { replyMarkup: prizeButton } : {},
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
  if (b.phase !== "filling" || b.filled === undefined || b.capacity === undefined) {
    return "This bracket isn't open for joins.";
  }
  // Capture so narrowing survives the awaits below. `paid` is undefined for
  // free (seed-only) brackets — then joining is just an entry, no fee.
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
    const calls = [...bracketEntryCalls(b.state, match.id, playerAddress)];
    if (paid) {
      calls.push(
        ...bracketFeePrizeCalls(b.state, {
          tokenAddress: paid.tokenAddress,
          fee: paid.fee,
          tiersBps: paid.tiersBps,
        }),
      );
    }
    await session.data.account.execute(calls);
  } catch (error) {
    // Roll back the slot so it stays open for a retry.
    if (slotA) match.playerA = placeholder(seed);
    else match.playerB = placeholder(seed);
    b.state.players[seed - 1] = placeholder(seed);
    return `Couldn't ${sponsoring ? "sponsor" : "join"}: ${formatError(error)}`;
  }

  b.filled += 1;
  if (b.filled >= b.capacity) b.phase = "live";
  // Remember a self-joiner's chat so the poller can DM them play/submit/claim
  // prompts. (Sponsored players' chats are unknown — they get channel posts.)
  if (!sponsoring) (b.playerChats ??= {})[addr] = payerChatId;
  await store.save(b);
  await updatePaidCard(api, b);

  // DM the joiner a direct Play link right away, so they never hunt for the id.
  // (Their match starts at the sign-up deadline; the tournament page shows when.)
  if (!sponsoring && match.tournamentId) {
    const url = tournamentPageUrl(b.state.chain as Chain, match.tournamentId);
    await api
      .sendMessage(
        payerChatId,
        `✅ You're in ${b.state.namePrefix ?? "the bracket"}! ▶️ Play your round-1 match here (opens when round 1 starts):\n${url}`,
        { replyMarkup: { inline_keyboard: [[{ text: "▶️ Play", url }]] } },
      )
      .catch(() => {});
  }
  const paidPrefix = paid ? `Paid ${paid.label} — ` : "";
  if (b.phase === "live") {
    return `✅ ${paidPrefix}${sponsoring ? "sponsored entry added" : "you're in"}; the bracket is starting!`;
  }
  const who = sponsoring ? `${playerName ?? short(playerAddress)} is in (sponsored)` : "you're in";
  return `✅ ${paidPrefix}${who}! (${b.filled}/${b.capacity})`;
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
 * /sponsor <id> <address|username> — pay another player's entry into a
 * paid bracket from your own session (run in DM, where your session lives).
 */
/**
 * Start the DM sponsor flow from a channel deeplink (t.me/<bot>?start=sponsor_<id>).
 * The bracket id rides in the deeplink, so the sponsor only supplies the player —
 * no long id to type. The reply is handled at the top of handleAnswer.
 */
export async function startSponsorFlow(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  bracketId: string,
): Promise<void> {
  const b = await store.get(bracketId);
  if (!b || b.phase !== "filling") {
    await api.sendMessage(chatId, "That bracket isn't open for sponsoring right now.");
    return;
  }
  const chain = b.state.chain as Chain;
  const session = await resolveAccount(chatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(chatId, "Connect first — run /connect, then tap 🎁 Sponsor again.");
    return;
  }
  sponsorPending.set(chatId, bracketId);
  const name = b.state.namePrefix ?? `bracket ${bracketId}`;
  const fee = b.paid ? ` — you'll pay ${b.paid.label}` : "";
  await api.sendMessage(
    chatId,
    `🎁 Sponsoring a player into ${name}${fee}.\nWho? Reply with a 0x address or a Cartridge username. /cancel to abort.`,
  );
}

export async function sponsorPaid(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  id: string,
  target: string,
): Promise<void> {
  const b = await store.get(id);
  if (!b || b.phase !== "filling") {
    await api.sendMessage(chatId, `No up-front bracket ${id} is open for sponsorship.`);
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

/** budokan.gg URL of the bracket's FINAL match (its winner is the champion, so
 *  that's where the prize pool goes). Undefined until the final is created. */
function bracketFinalUrl(state: BracketState): string | undefined {
  const final = state.matches.find((m) => m.round === bracketRounds(state) && m.tournamentId);
  return final?.tournamentId ? tournamentPageUrl(state.chain as Chain, final.tournamentId) : undefined;
}

/** Guidance for adding a prize pool — always to the FINAL match on budokan.gg. */
function addPrizeHint(state: BracketState): string {
  const url = bracketFinalUrl(state);
  return url
    ? `🏆 Want a prize pool? Add it on budokan.gg to the bracket's FINAL match — its winner is the champion, so the pool lives there. Tap the button below (or open ${url}).`
    : `🏆 To add a prize pool, sponsor the FINAL match on budokan.gg once the tree is live.`;
}

/** Inline button linking straight to the final match's budokan.gg page. */
function addPrizeButton(state: BracketState): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  const url = bracketFinalUrl(state);
  return url ? { inline_keyboard: [[{ text: "🏆 Add prize (final match)", url }]] } : undefined;
}

function paidCard(b: StoredBracket): string {
  const cap = b.capacity ?? 0;
  const filled = b.filled ?? 0;
  const remaining = cap - filled;
  const real = b.state.players.filter(isReal);
  const tiersBps = b.paid?.tiersBps;
  const lines = [
    "━━━━━━━━━━━━━━━━━━",
    `🥊 ${b.state.namePrefix} — 1v1 Bracket`,
    "📊 Registration",
    `👥 Players: ${filled}/${cap}`,
  ];
  if (b.description) lines.push(`📝 ${b.description}`);
  if (b.paid) lines.push(`💸 Entry: ${b.paid.label} (adds to pool)`);
  else lines.push(`💸 Entry: free`);
  if (tiersBps) lines.push(`📊 Pays: ${tiersBps.map((bp) => `${(bp / 100).toFixed(0)}%`).join(" / ")}`);
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
  const joinLabel = b.paid ? `🎮 Join — ${b.paid.label}` : `🎮 Join (free)`;
  // Sponsor needs a target player (typed), so it opens a DM already scoped to
  // this bracket via a deeplink — the user only supplies the player, never the
  // long id. Falls back to a callback (points to the DM command) if we don't
  // know our own @username yet.
  const sponsorBtn: InlineKeyboardButton = botUsername
    ? { text: `🎁 Sponsor a player`, url: `https://t.me/${botUsername}?start=sponsor_${b.state.id}` }
    : { text: `🎁 Sponsor a player`, callback_data: `bspon:${b.state.id}` };
  return {
    inline_keyboard: [
      [{ text: `${joinLabel} (${b.filled ?? 0}/${b.capacity ?? 0})`, callback_data: `bjoin:${b.state.id}` }],
      [sponsorBtn],
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
    `To sponsor a player, DM me:  /sponsor ${id} <address or Cartridge username>`,
    true,
  );
}

async function updatePaidCard(api: TelegramApi, b: StoredBracket): Promise<void> {
  if (!b.cardChatId || b.cardMessageId === undefined) return;
  await api.editCard(b.cardChatId, b.cardMessageId, paidCard(b), paidJoinKeyboard(b));
}

// ----- advancement (poller) -----

/** Anything that can sign + submit the winner-entry multicalls. */
type Advancer = { execute: (calls: ReturnType<typeof bracketEntryCalls>) => Promise<{ transaction_hash: string }> };

/**
 * The bot-operator account, if configured: a funded Starknet account the poller
 * uses to enter winners on their behalf, so advancement never hinges on the
 * organizer's session. Entering is permissionless (no fund access) — the
 * account only needs STRK for gas.
 */
function getOperatorAccount(config: Config, chain: Chain): Advancer | null {
  if (!config.operatorPrivateKey || !config.operatorAddress) return null;
  const provider = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(chain, config.rpcUrl) });
  return new Account({
    provider,
    address: config.operatorAddress,
    signer: config.operatorPrivateKey,
  }) as unknown as Advancer;
}

/** Brackets we've already DM'd the organizer about (no operator + session gone). */
const stalledNudged = new Set<string>();

/**
 * Proactive per-player DMs at match transitions so players can drive the bracket
 * themselves (play → submit scores → claim), with the bot as a backstop rather
 * than the critical path. Best-effort: only players whose chat we captured on
 * self-join get DMs; everyone still sees the public channel card. Dedup'd via
 * `b.notified` so each prompt is sent once.
 */
async function notifyBracket(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  b: StoredBracket,
): Promise<void> {
  const chats = b.playerChats;
  if (!chats || Object.keys(chats).length === 0) return; // nobody we can DM

  const chain = b.state.chain as Chain;
  const sent = new Set(b.notified ?? []);
  let changed = false;

  const dm = async (address: string | undefined, key: string, text: string): Promise<void> => {
    if (!address) return;
    const chatId = chats[address.toLowerCase()];
    if (!chatId || sent.has(key)) return;
    sent.add(key);
    changed = true;
    await api.sendMessage(chatId, text).catch(() => {});
  };

  let client: ReturnType<typeof createBudokanClient> | undefined;
  const getClient = () =>
    (client ??= createBudokanClient({
      chain,
      ...(config.apiUrl ? { apiBaseUrl: config.apiUrl } : {}),
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
      ...(config.budokanAddress ? { budokanAddress: config.budokanAddress } : {}),
      ...(config.viewerAddress ? { viewerAddress: config.viewerAddress } : {}),
    } as Parameters<typeof createBudokanClient>[0]));

  const name = b.state.namePrefix ?? "Bracket";

  for (const m of b.state.matches) {
    if (!m.tournamentId) continue;
    const realPlayers = [m.playerA, m.playerB].filter((p): p is NonNullable<typeof p> => !!p && isReal(p));

    if (m.status === "live") {
      const url = tournamentPageUrl(chain, m.tournamentId);
      // Keys are per-player: both competitors must be DM'd, so the dedup key
      // can't be shared across them.
      for (const p of realPlayers) {
        await dm(p.address, `${m.id}:${p.address.toLowerCase()}:live`, `▶️ ${name}: your round ${m.round} match is live — play now:\n${url}`);
      }
      // Game window closed but the match isn't resolved → scores need submitting.
      // Only pay for the timing read if someone still needs the submit prompt.
      const needsSubmit = realPlayers.some((p) => !sent.has(`${m.id}:${p.address.toLowerCase()}:submit`));
      if (needsSubmit) {
        try {
          const t = await getClient().getTournament(m.tournamentId);
          const end = Number(t?.gameEndTime ?? 0);
          if (end > 0 && Math.floor(Date.now() / 1000) >= end) {
            for (const p of realPlayers) {
              await dm(
                p.address,
                `${m.id}:${p.address.toLowerCase()}:submit`,
                `📥 ${name}: round ${m.round} is over — submit the scores so the winner is recorded (anyone can do it once, for both players):\n/submit_score ${m.tournamentId}  → then reply "all"`,
              );
            }
          }
        } catch {
          // couldn't read timing this tick — retry next cycle
        }
      }
    }

    if ((m.status === "resolved" || m.status === "walkover") && m.winner) {
      await dm(
        m.winner.address,
        `${m.id}:won`,
        `🏆 ${name}: you won round ${m.round}! I'll enter you into the next match — watch for the play link.`,
      );
    }
  }

  if (b.state.status === "complete" && b.state.champion) {
    const finalMatch = b.state.matches.find((m) => !m.feedsInto && m.tournamentId);
    await dm(
      b.state.champion.address,
      "complete",
      `🏆 ${name}: you won the whole bracket! Claim your prize:\n/claim ${finalMatch?.tournamentId ?? ""}`.trim(),
    );
  }

  if (changed) {
    b.notified = [...sent];
    await store.save(b);
  }
}

export async function advanceStoredBracket(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  b: StoredBracket,
): Promise<void> {
  // A paid bracket still gathering players isn't running yet — don't advance it.
  if (b.phase === "filling") return;
  const chain = b.state.chain as Chain;

  // 1. Update bracket state from chain (resolve finished matches). No signer
  //    needed — just reads.
  const before = bracketSummary(b.state);
  const read = buildReader(config, chain);
  const { state } = await advanceBracket(b.state, read);
  b.state = state;

  // 2. Proactive player DMs (play / submit-scores / advanced / claim) —
  //    independent of whether we can sign, so players can drive it themselves.
  await notifyBracket(api, config, store, b);

  // 3. Enter the round's winners into the next match. Prefer the bot operator
  //    (no organizer dependency); fall back to the organizer's session.
  let advancer = getOperatorAccount(config, chain);
  if (!advancer) {
    const session = await resolveAccount(b.organizerChatId, chain, config);
    if (session.ok) advancer = session.data.account as unknown as Advancer;
  }
  if (advancer) {
    stalledNudged.delete(b.state.id);
    const entered = new Set<string>(b.entered ?? []);
    for (const m of state.matches) {
      if (m.round === 1 || !m.tournamentId || entered.has(m.id)) continue;
      if (!m.playerA || !m.playerB) continue;
      try {
        for (const player of [m.playerA, m.playerB]) {
          // Skip placeholder (0x0) slots — a walkover auto-advances, and
          // entering 0x0 would just be a failing tx.
          if (!isReal(player)) continue;
          await advancer.execute(bracketEntryCalls(state, m.id, player.address));
        }
        entered.add(m.id);
      } catch (error) {
        console.error(`bracket ${state.id} enter ${m.id} failed:`, formatError(error));
      }
    }
    b.entered = [...entered];
  } else if (!stalledNudged.has(b.state.id)) {
    // Can't auto-advance (no operator + organizer session expired). Players were
    // still nudged to play/submit above; ask the organizer to reconnect.
    stalledNudged.add(b.state.id);
    await api
      .sendMessage(
        b.organizerChatId,
        `⏳ Bracket ${b.state.id} is waiting to advance — run /connect again so I can enter the round's winners (or set a bot operator account to do it automatically).`,
      )
      .catch(() => {});
  }

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
  quietIfEmpty = false,
): Promise<void> {
  const deployed = (await store.all()).filter((b) => (b.state.chain as Chain) === chain);
  if (deployed.length === 0) {
    // quietIfEmpty: when rendered as a section of /tournaments, stay silent.
    if (!quietIfEmpty) await api.sendMessage(chatId, `No brackets on ${chain}. Start one with /create.`);
    return;
  }
  const lines = [`🥊 Brackets on ${chain}:`, ""];
  for (const b of deployed) {
    const champ = b.state.champion ? ` — 🏆 ${b.state.champion.name ?? short(b.state.champion.address)}` : "";
    const phase = b.phase === "filling" ? `filling ${b.filled ?? 0}/${b.capacity ?? 0}` : b.state.status;
    lines.push(`  • ${b.state.id} [${phase}] · ${b.state.players.length} players${champ} · view: /tournaments ${b.state.id}`);
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
  await api.sendMessage(chatId, `No bracket ${id}.`);
}

async function announceTo(api: TelegramApi, chatId: string, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, text);
  } catch (error) {
    console.error("bracket announce failed:", formatError(error));
  }
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
  const lines = ["⏱️ How long is each match?", ""];
  LENGTH_PRESETS.forEach((p, i) => lines.push(`  ${i + 1}. ${p.label}`));
  lines.push("", "Reply with a number. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

async function sendStartPrompt(api: TelegramApi, d: Draft, chatId: string): Promise<void> {
  d.step = "start";
  const lines = ["⏰ When should round 1 start? (players sign up / get ready until then)", ""];
  START_PRESETS.forEach((p, i) => lines.push(`  ${i + 1}. ${p.label}`));
  lines.push(
    "",
    `Reply a number, or a custom time: "in 2 days", "in 90 minutes", or a UTC time like "2026-07-05 18:00". Minimum 1 hour out. /cancel to abort.`,
  );
  await api.sendMessage(chatId, lines.join("\n"));
}

/** Parse the start step: a preset number, "in N min/hours/days", or a UTC
 *  "YYYY-MM-DD HH:MM". Returns seconds-from-now (≥ 1h, ≤ 30d) or null. */
function parseStartDelay(input: string): number | null {
  const t = input.trim().toLowerCase();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= START_PRESETS.length ? START_PRESETS[n - 1]!.sec : null;
  }
  const rel = /^in\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)$/.exec(t);
  if (rel) {
    const qty = Number(rel[1]);
    const unit = rel[2]!;
    const mult = /^m/.test(unit) ? 60 : /^h/.test(unit) ? 3600 : 86400;
    return clampStartDelay(Math.round(qty * mult));
  }
  const abs = /^(\d{4}-\d{2}-\d{2})[ t](\d{2}:\d{2})/.exec(t);
  if (abs) {
    const ms = Date.parse(`${abs[1]}T${abs[2]}:00Z`);
    if (Number.isFinite(ms)) return clampStartDelay(Math.round((ms - Date.now()) / 1000));
  }
  return null;
}

function clampStartDelay(sec: number): number | null {
  if (!Number.isFinite(sec) || sec < MIN_START_SEC) return null;
  return Math.min(sec, 30 * 86400); // cap 30 days
}

/** "<UTC datetime> (in ~Nh)" for confirm/deploy messages. */
function startSummary(delaySec: number): string {
  const at = new Date(Date.now() + delaySec * 1000);
  const when = at.toISOString().slice(0, 16).replace("T", " ");
  const h = delaySec / 3600;
  const rel = h < 1 ? `${Math.round(delaySec / 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
  return `${when} UTC (in ~${rel})`;
}

/** Numbered token picker for the entry-fee step. */
async function sendTokenList(
  api: TelegramApi,
  chain: Chain,
  chatId: string,
  header: string,
  zeroLabel: string,
): Promise<void> {
  const tokens = spendableTokens(chain);
  const lines = [header, ""];
  tokens.forEach((tk, i) => lines.push(`  ${i + 1}. ${tk.symbol}`));
  lines.push(`  0. ${zeroLabel}`);
  lines.push("", "Reply with a number. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

/**
 * Tokens the /connect session can actually escrow — i.e. those with an `approve`
 * spend cap in the session policy (see policies.ts). Entry fees must come from
 * here, or the in-session escrow would be unauthorized.
 */
function spendableTokens(chain: Chain): readonly Erc20Token[] {
  return tokensForChain(chain).filter((t) => t.spendLimit);
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

/**
 * Funding step. Open brackets take an optional per-entry fee (in-session, ≤ the
 * ~$10 session cap) that builds the placement pool. Closed brackets have no
 * in-bot funding — the organizer adds any prize on budokan.gg after creation.
 */
async function sendFundingPrompt(api: TelegramApi, d: Draft, chatId: string): Promise<void> {
  if (d.mode === "open") {
    d.step = "feeToken";
    await sendFeeTokenPrompt(api, d.chain, chatId);
  } else {
    d.step = "confirm";
    await api.sendMessage(chatId, confirmText(d));
  }
}

async function sendNamePrompt(api: TelegramApi, d: Draft, chatId: string): Promise<void> {
  d.step = "name";
  await api.sendMessage(
    chatId,
    `🏷️ Bracket name? (titles the card + each match, e.g. "Friday Cup") Reply with text, or 'skip' to use "${d.game!.name}". /cancel to abort.`,
  );
}

async function sendDescriptionPrompt(api: TelegramApi, d: Draft, chatId: string): Promise<void> {
  d.step = "description";
  await api.sendMessage(
    chatId,
    "📝 Bracket description? It shows on the card + budokan.gg. Reply with text, or 'skip'. /cancel to abort.",
  );
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
    d.settingsName = "Default";
    await api.sendMessage(chatId, "No custom settings for this game — using the game's built-in default.");
    await sendNamePrompt(api, d, chatId);
    return;
  }
  const pages = Math.max(1, Math.ceil(page.total / page.limit));
  const lines = [
    `⚙️ Settings for ${d.game!.name} (page ${Math.floor(offset / page.limit) + 1} of ${pages}):`,
    "",
  ];
  page.data.forEach((s, i) => {
    lines.push(`  ${i + 1}. ${s.name || "Unnamed"}`);
    if (s.description) lines.push(`     ${truncate(s.description, 88)}`);
  });
  lines.push(
    "",
    "Reply a number to pick, or '<n>?' to see what it does (e.g. 1?).",
    "'next' / 'prev' to page, 'skip' for the game default ('default?' to inspect it). /cancel to abort.",
  );
  await api.sendMessage(chatId, lines.join("\n"));
}

async function handleBracketSettings(api: TelegramApi, d: Draft, chatId: string, input: string): Promise<void> {
  const lower = input.toLowerCase();
  if (lower === "skip") {
    d.settingsId = 0;
    d.settingsName = "Default";
    await sendNamePrompt(api, d, chatId);
    return;
  }
  // Inspect the game default ("default?" / "0?") — show what it actually does.
  if (lower === "default?" || lower === "0?") {
    await inspectSetting(api, d, chatId, 0);
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
  // Inspect a listed setting: "<n>?" → show its description + parameters.
  const inspectMatch = /^(\d+)\?$/.exec(input.trim());
  if (inspectMatch) {
    const idx = Number(inspectMatch[1]);
    if (idx < 1 || idx > page.data.length) {
      await api.sendMessage(chatId, `No setting ${idx} on this page. Reply 1–${page.data.length}, or 'default?'.`);
      return;
    }
    await api.sendMessage(
      chatId,
      `${formatSettingsDetails(page.data[idx - 1]!)}\n\nReply ${idx} to use it, another number, or 'skip' for the default.`,
    );
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
  d.settingsName = chosen.name || "Default";
  await sendNamePrompt(api, d, chatId);
}

/**
 * Per-round settings prompt. Offers the game's settings by name (numbered, no
 * raw ids), one pick per round. Skipped automatically when there's nothing to
 * vary (0–1 settings available).
 */
async function sendRoundSettingsPrompt(api: TelegramApi, d: Draft, chatId: string): Promise<void> {
  const rounds = Math.log2(d.capacity ?? d.players?.length ?? 2);
  const base = d.settingsName || "Default";
  let list: GameSettingDetails[] = [];
  try {
    list = (await fetchSettings(d.chain, d.game!.contractAddress, { limit: 25 })).data;
  } catch {
    // settings unavailable — just use the chosen one throughout
  }
  d.settingsList = list;
  if (list.length < 2) {
    await sendFundingPrompt(api, d, chatId);
    return;
  }
  d.step = "roundSettings";
  const example = Array.from({ length: rounds }, (_, i) => Math.min(i + 1, list.length)).join(",");
  const lines = [
    `⚙️ Different settings per round? This bracket has ${rounds} rounds, all using "${base}" by default.`,
    "",
    ...list.map((s, i) => `  ${i + 1}. ${s.name || "Unnamed"}`),
    "",
    `Reply 'skip' to use "${base}" every round, or give ${rounds} numbers (round 1 → final), e.g. ${example}.`,
    "'<n>?' to see what a setting does.",
  ];
  await api.sendMessage(chatId, lines.join("\n"));
}

/** Show a settings entry's details (incl. id 0 = the game default). */
async function inspectSetting(api: TelegramApi, d: Draft, chatId: string, id: number): Promise<void> {
  const detail = await fetchSetting(d.chain, d.game!.contractAddress, id);
  if (!detail) {
    await api.sendMessage(
      chatId,
      id === 0
        ? "ℹ️ 'Default' is the game's built-in configuration — it has no custom parameters recorded. Pick a number for a custom setting, or 'skip' to use it."
        : `Couldn't load settings #${id}.`,
    );
    return;
  }
  await api.sendMessage(chatId, `${formatSettingsDetails(detail)}\n\nReply a number to pick, or 'skip' for the default.`);
}

/** Truncate long text for one-line previews. */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function confirmText(d: Draft): string {
  const roster =
    d.mode === "open"
      ? `open, capacity ${d.capacity}`
      : `closed — ${d.players!.length} players`;
  return [
    "🧾 Confirm bracket:",
    `  • Game: ${d.game!.name}`,
    `  • Name: ${d.namePrefix ?? d.game!.name}`,
    `  • Settings: ${d.settingsName ?? "Default"}${
      d.roundSettingsIds
        ? ` (per round: ${d.roundSettingsIds
            .map((id) => d.settingsList?.find((s) => s.id === id)?.name || "Default")
            .join(" → ")})`
        : ""
    }`,
    ...(d.description ? [`  • Description: ${d.description}`] : []),
    `  • Roster: ${roster}`,
    `  • Match length: ${d.length!.label}`,
    ...(d.startDelaySec ? [`  • Starts: ${startSummary(d.startDelaySec)}`] : []),
    ...(d.entryFee
      ? [
          `  • Entry fee: ${d.entryFee.label} (adds to pool)`,
          `  • Pays: ${(d.tiersBps ?? [10000]).map((b) => `${(b / 100).toFixed(0)}%`).join(" / ")}`,
        ]
      : [`  • Entry: free`]),
    `  • Prize pool: add on budokan.gg after creation`,
    "",
    d.mode === "open"
      ? "Deploys the gated tree now; players tap Join to enter. Round 1 starts at the sign-up deadline — empty slots walk over."
      : "Deploys the gated tree now and enters round 1 for the players.",
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
