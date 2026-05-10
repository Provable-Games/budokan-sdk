// Multi-turn /create state machine with numbered chat pickers.
//
// Each chat can have at most one in-flight create flow at a time. State is
// in-memory only; restart loses it (the user just runs /create again).
//
// UX improvements over the v1 12-step Q&A:
//   - Game: numbered pick from games-catalog (chain-aware)
//   - Settings: numbered pick from denshokan-sdk (paginated; supports
//     "next"/"prev" between pages and "search <q>" within a page)
//   - Schedule: presets + "custom" fallback
//   - Entry fee: optional numbered token pick + amount + leaderboard size
//   - Sponsored prizes: optional, picked from the user's Voyager balances
//
// The form remains "minimal" — entry_requirement is unsupported, salt and
// metadata_value default to 0, fee distribution is exponential.

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import type { TelegramApi } from "../telegram-api.ts";
import {
  buildCreateTournamentCall,
  buildErc20ApproveCall,
  type Call,
  type CreateTournamentArgs,
  type DistributionSpec,
  type EntryFeeArgs,
} from "../budokan-calls.ts";
import { resolveAccount } from "../controller-account.ts";
import { CHAINS } from "@provable-games/budokan-sdk";

import { gamesForChain, gameMetadataFor, type Game } from "../catalog/games.ts";
import { tokensForChain, findKnownToken, type Erc20Token } from "../catalog/tokens.ts";
import { fetchSettings, type GameSettingDetails } from "../catalog/settings.ts";
import { fetchVoyagerBalances, filterPrizeEligible, type VoyagerTokenBalance } from "../voyager.ts";

type Step =
  | "game"
  | "name"
  | "description"
  | "settings"
  | "schedule"
  | "scheduleCustom"
  | "leaderboard"
  | "entryFeeChoice"
  | "entryFeeToken"
  | "entryFeeAmount"
  | "entryFeeGameShare"
  | "entryFeeCreatorShare"
  | "entryFeeRefundShare"
  | "entryFeeDistCount"
  | "entryFeeDistType"
  | "entryFeeDistWeight"
  | "prizesChoice"
  | "prizesPick"
  | "prizesAmount"
  | "confirm";

// Schedule presets — both "fixed registration" (closed before play starts)
// and "open registration" (players can join throughout the tournament).
//
// Open tournaments are encoded by setting both registration_start_delay and
// registration_end_delay to 0. The contract's `has_registration()` returns
// false in that case, so the phase machine skips Registration and entries
// are accepted from creation until the tournament ends.
type SchedulePreset = {
  name: string;
  regStart: number;
  regDuration: number;
  staging: number;
  gameDuration: number;
  submission: number;
};

// Submission window is hardcoded to 24h across all presets and the custom
// flow. Tournament creators almost always pick this; can be lifted into a
// question if it becomes a real constraint.
const SUBMISSION_SECONDS = 86400;

const FIXED_PRESETS: readonly SchedulePreset[] = [
  { name: "Quickfire — 1h reg / 1h play",
    regStart: 0, regDuration: 3600, staging: 0, gameDuration: 3600, submission: SUBMISSION_SECONDS },
  { name: "Same-day — 1h reg / 8h play",
    regStart: 0, regDuration: 3600, staging: 0, gameDuration: 28800, submission: SUBMISSION_SECONDS },
  { name: "Standard — 24h reg / 24h play",
    regStart: 0, regDuration: 86400, staging: 0, gameDuration: 86400, submission: SUBMISSION_SECONDS },
  { name: "Weekend — 24h reg / 48h play",
    regStart: 0, regDuration: 86400, staging: 0, gameDuration: 172800, submission: SUBMISSION_SECONDS },
  { name: "Weeklong — 24h reg / 7d play",
    regStart: 0, regDuration: 86400, staging: 0, gameDuration: 604800, submission: SUBMISSION_SECONDS },
];

// Open variants: regStart=0, regDuration=0, staging=0 → tournament begins
// immediately, registration stays open throughout play.
const OPEN_PRESETS: readonly SchedulePreset[] = [
  { name: "Open Quickfire — 1h play",
    regStart: 0, regDuration: 0, staging: 0, gameDuration: 3600, submission: SUBMISSION_SECONDS },
  { name: "Open Same-day — 8h play",
    regStart: 0, regDuration: 0, staging: 0, gameDuration: 28800, submission: SUBMISSION_SECONDS },
  { name: "Open Standard — 24h play",
    regStart: 0, regDuration: 0, staging: 0, gameDuration: 86400, submission: SUBMISSION_SECONDS },
  { name: "Open Weekend — 48h play",
    regStart: 0, regDuration: 0, staging: 0, gameDuration: 172800, submission: SUBMISSION_SECONDS },
  { name: "Open Weeklong — 7d play",
    regStart: 0, regDuration: 0, staging: 0, gameDuration: 604800, submission: SUBMISSION_SECONDS },
];

const SCHEDULE_PRESETS: readonly SchedulePreset[] = [...FIXED_PRESETS, ...OPEN_PRESETS];

interface SettingsPage {
  data: GameSettingDetails[];
  total: number;
  limit: number;
  offset: number;
}

interface PrizeSpec {
  token: VoyagerTokenBalance;
  amount: string;       // raw u256 amount (decimal string)
}

// Sections of the form. Used for edit-from-confirmation and /back-to-section.
// Each section has a first-step the editor jumps to, and a list of state
// fields cleared when the user starts editing that section (so re-walks
// see fresh state and re-ask the right questions).
type SectionId =
  | "game" | "metadata" | "settings" | "schedule"
  | "leaderboard" | "entryFee" | "prizes";

interface State {
  step: Step;
  chain: Chain;
  // True while re-editing a section from confirmation (or via /back). Each
  // section's exit transition checks this and jumps back to "confirm"
  // instead of the natural next section.
  editing?: boolean;
  // Snapshot of the games list at /create-start time, so the numbering the
  // user sees matches the indices we resolve against. denshokan registry
  // updates between picker render and pick would otherwise shift indices.
  gamesList: Game[];
  // Filled progressively.
  game?: Game;
  name?: string;
  description?: string;
  settingsId?: number;
  settingsName?: string;
  settingsPage?: SettingsPage;
  schedule?: { regStart: number; regDuration: number; staging: number; gameDuration: number; submission: number };
  customSchedule?: Partial<{ regStart: number; regDuration: number; staging: number; gameDuration: number; submission: number }>;
  customScheduleStep?: "style" | "regStart" | "regDuration" | "staging" | "gameDuration" | "submission";
  customScheduleStyle?: "fixed" | "open";
  leaderboardAscending?: boolean;
  gameMustBeOver?: boolean;
  // Entry fee — collected progressively when user opts in.
  entryFeeToken?: Erc20Token;
  entryFeeAmount?: string;          // raw u128 (decimal string)
  entryFeeCreatorBps?: number;      // tournament creator cut in basis points
  entryFeeGameBps?: number;         // game creator cut (must be ≥ registry minimum)
  entryFeeMinGameBps?: number;      // floor — registry-side minimum from whitelist
  entryFeeRefundBps?: number;       // refund share for non-placers
  entryFeeDistType?: "linear" | "exponential" | "uniform";
  entryFeeDistCount?: number;       // # placements that share the leaderboard pool
  entryFeeDistWeight?: number;      // client-units weight (×10 on chain). 1 = default.
  // Prizes — picked from the user's wallet balances.
  voyagerBalances?: VoyagerTokenBalance[];
  prizesSoFar: PrizeSpec[];
  pendingPrizeToken?: VoyagerTokenBalance;
}

const states = new Map<string, State>();

export function isPending(chatId: string): boolean {
  return states.has(chatId);
}

export function cancel(chatId: string): boolean {
  return states.delete(chatId);
}

export async function start(api: TelegramApi, chatId: string, chain: Chain): Promise<void> {
  let games: Game[];
  try {
    games = await gamesForChain(chain);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't load the game registry: ${formatError(error)}`);
    return;
  }
  if (games.length === 0) {
    await api.sendMessage(
      chatId,
      `No games registered on ${chain}. They may still be propagating; try again in a minute.`,
    );
    return;
  }
  states.set(chatId, { step: "game", chain, prizesSoFar: [], gamesList: games });
  await api.sendMessage(chatId, [
    `Let's create a tournament on ${chain}. /cancel to abort.`,
    "",
    "Pick a game:",
    ...games.map((g, i) => `  ${i + 1}. ${g.name} — ${shortHex(g.contractAddress)}`),
    "",
    "Reply with a number.",
  ].join("\n"));
}

export async function handleAnswer(
  api: TelegramApi,
  config: Config,
  chatId: string,
  text: string,
): Promise<void> {
  const state = states.get(chatId);
  if (!state) return;
  const trimmed = text.trim();

  switch (state.step) {
    case "game":
      return handleGame(api, state, chatId, trimmed);
    case "name":
      return handleName(api, state, chatId, trimmed);
    case "description":
      return handleDescription(api, state, chatId, trimmed);
    case "settings":
      return handleSettings(api, state, chatId, trimmed);
    case "schedule":
      return handleSchedule(api, state, chatId, trimmed);
    case "scheduleCustom":
      return handleScheduleCustom(api, state, chatId, trimmed);
    case "leaderboard":
      return handleLeaderboard(api, state, chatId, trimmed);
    case "entryFeeChoice":
      return handleEntryFeeChoice(api, config, state, chatId, trimmed);
    case "entryFeeToken":
      return handleEntryFeeToken(api, config, state, chatId, trimmed);
    case "entryFeeAmount":
      return handleEntryFeeAmount(api, config, state, chatId, trimmed);
    case "entryFeeGameShare":
      return handleEntryFeeGameShare(api, config, state, chatId, trimmed);
    case "entryFeeCreatorShare":
      return handleEntryFeeCreatorShare(api, config, state, chatId, trimmed);
    case "entryFeeRefundShare":
      return handleEntryFeeRefundShare(api, config, state, chatId, trimmed);
    case "entryFeeDistCount":
      return handleEntryFeeDistCount(api, config, state, chatId, trimmed);
    case "entryFeeDistType":
      return handleEntryFeeDistType(api, config, state, chatId, trimmed);
    case "entryFeeDistWeight":
      return handleEntryFeeDistWeight(api, config, state, chatId, trimmed);
    case "prizesChoice":
      return handlePrizesChoice(api, config, state, chatId, trimmed);
    case "prizesPick":
      return handlePrizesPick(api, config, state, chatId, trimmed);
    case "prizesAmount":
      return handlePrizesAmount(api, config, state, chatId, trimmed);
    case "confirm":
      return handleConfirm(api, config, state, chatId, trimmed);
  }
}

async function handleGame(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  const idx = parsePickIndex(input, state.gamesList.length);
  if (idx === null) {
    await api.sendMessage(chatId, `Reply with a number 1-${state.gamesList.length}, or /cancel.`);
    return;
  }
  state.game = state.gamesList[idx];
  if (await maybeReturnToConfirm(api, state, chatId)) return;
  state.step = "name";
  await api.sendMessage(
    chatId,
    `Selected: ${state.game!.name} (${shortHex(state.game!.contractAddress)})\n\nTournament name? (≤31 ASCII characters)`,
  );
}

async function handleName(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  if (input.length === 0 || input.length > 31) {
    await api.sendMessage(chatId, "Name must be 1–31 characters. Try again, or /cancel.");
    return;
  }
  if (!/^[\x20-\x7e]+$/.test(input)) {
    await api.sendMessage(chatId, "Name must be plain ASCII. Try again.");
    return;
  }
  state.name = input;
  state.step = "description";
  await api.sendMessage(chatId, "Description? (free text, or send 'skip')");
}

async function handleDescription(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  state.description = /^skip$/i.test(input) ? "" : input;
  if (await maybeReturnToConfirm(api, state, chatId)) return;
  // Move into settings: fetch the first page.
  await renderSettingsPage(api, state, chatId, 0);
}

async function renderSettingsPage(api: TelegramApi, state: State, chatId: string, offset: number): Promise<void> {
  state.step = "settings";
  let page: SettingsPage;
  try {
    page = await fetchSettings(state.chain, state.game!.contractAddress, { limit: 5, offset });
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't load settings: ${formatError(error)}\nReply 'retry' or 'skip' (uses settings ID 0).`);
    state.settingsPage = undefined;
    return;
  }
  state.settingsPage = page;
  if (page.data.length === 0) {
    await api.sendMessage(chatId, "No settings registered for this game. Using settings ID 0.");
    state.settingsId = 0;
    state.settingsName = "(default)";
    return moveToSchedule(api, state, chatId);
  }
  const lines = [
    `Settings for ${state.game!.name} (page ${Math.floor(offset / page.limit) + 1} of ${Math.max(1, Math.ceil(page.total / page.limit))}):`,
    "",
    ...page.data.map((s, i) => `  ${i + 1}. ID ${s.id}${s.name ? ` — ${s.name}` : ""}${s.description ? `\n     ${truncate(s.description, 80)}` : ""}`),
    "",
    "Reply with a number, or 'next' / 'prev', or 'skip' to use ID 0.",
  ];
  await api.sendMessage(chatId, lines.join("\n"));
}

async function handleSettings(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  const lower = input.toLowerCase();
  if (lower === "skip") {
    state.settingsId = 0;
    state.settingsName = "(default)";
    return moveToSchedule(api, state, chatId);
  }
  if (lower === "retry") {
    return renderSettingsPage(api, state, chatId, state.settingsPage?.offset ?? 0);
  }
  const page = state.settingsPage;
  if (!page) {
    return renderSettingsPage(api, state, chatId, 0);
  }
  if (lower === "next") {
    const nextOffset = page.offset + page.limit;
    if (nextOffset >= page.total) {
      await api.sendMessage(chatId, "Already on the last page.");
      return;
    }
    return renderSettingsPage(api, state, chatId, nextOffset);
  }
  if (lower === "prev") {
    if (page.offset === 0) {
      await api.sendMessage(chatId, "Already on the first page.");
      return;
    }
    return renderSettingsPage(api, state, chatId, Math.max(0, page.offset - page.limit));
  }
  const idx = parsePickIndex(input, page.data.length);
  if (idx === null) {
    await api.sendMessage(chatId, `Reply with 1-${page.data.length}, 'next', 'prev', or 'skip'.`);
    return;
  }
  const chosen = page.data[idx]!;
  state.settingsId = chosen.id;
  state.settingsName = chosen.name ?? `ID ${chosen.id}`;
  await moveToSchedule(api, state, chatId);
}

async function moveToSchedule(api: TelegramApi, state: State, chatId: string): Promise<void> {
  if (await maybeReturnToConfirm(api, state, chatId)) return;
  state.step = "schedule";
  // Group presets by style so the user sees the structural choice
  // (fixed vs open registration) before picking durations.
  const lines: string[] = [
    `Settings: ${state.settingsName}`,
    "",
    "Pick a schedule preset.",
    "",
    "Fixed registration (registration window closes before play starts):",
    ...FIXED_PRESETS.map((p, i) => `  ${i + 1}. ${p.name}`),
    "",
    "Open registration (players can join throughout play):",
    ...OPEN_PRESETS.map(
      (p, i) => `  ${FIXED_PRESETS.length + i + 1}. ${p.name}`,
    ),
    "",
    `  ${SCHEDULE_PRESETS.length + 1}. Custom (I'll ask for each window)`,
    "",
    "Reply with a number.",
  ];
  await api.sendMessage(chatId, lines.join("\n"));
}

/**
 * If state.editing is set, end the section here and jump straight to the
 * confirmation summary. Returns true if the caller should bail out of its
 * normal "advance to next section" path.
 */
async function maybeReturnToConfirm(api: TelegramApi, state: State, chatId: string): Promise<boolean> {
  if (!state.editing) return false;
  state.editing = false;
  await moveToConfirm(api, state, chatId);
  return true;
}

async function handleSchedule(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  const idx = parsePickIndex(input, SCHEDULE_PRESETS.length + 1);
  if (idx === null) {
    await api.sendMessage(chatId, `Reply 1-${SCHEDULE_PRESETS.length + 1}.`);
    return;
  }
  if (idx < SCHEDULE_PRESETS.length) {
    const p = SCHEDULE_PRESETS[idx]!;
    state.schedule = { regStart: p.regStart, regDuration: p.regDuration, staging: p.staging, gameDuration: p.gameDuration, submission: p.submission };
    return moveToLeaderboard(api, state, chatId);
  }
  // Custom path — ask registration style first.
  state.step = "scheduleCustom";
  state.customSchedule = {};
  state.customScheduleStep = "style";
  await api.sendMessage(chatId, [
    "Custom schedule. Registration style?",
    "  1. Fixed — registration window closes before play starts",
    "  2. Open — players can join throughout play",
    "",
    "Reply with a number.",
  ].join("\n"));
}

async function handleScheduleCustom(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  const step = state.customScheduleStep!;

  // Step 1 — pick fixed vs open. Branches the rest of the prompts.
  if (step === "style") {
    const idx = parsePickIndex(input, 2);
    if (idx === null) { await api.sendMessage(chatId, "Reply 1 (fixed) or 2 (open)."); return; }
    state.customScheduleStyle = idx === 0 ? "fixed" : "open";
    if (state.customScheduleStyle === "fixed") {
      state.customScheduleStep = "regStart";
      await api.sendMessage(chatId, "When does registration open? Send 'now', or a duration like '2h', '30m', '1d'.");
    } else {
      // Open: skip reg fields entirely (they stay 0). Optional staging delay
      // before play starts.
      state.customSchedule!.regStart = 0;
      state.customSchedule!.regDuration = 0;
      state.customScheduleStep = "staging";
      await api.sendMessage(chatId, "When does play start? Send 'now', or '1h', '2h' for a delay.");
    }
    return;
  }

  const seconds = parseDuration(input, step === "regStart" || step === "staging");
  if (seconds === null || (step !== "regStart" && step !== "staging" && seconds <= 0)) {
    await api.sendMessage(chatId, "Couldn't parse that. Examples: 'now', '0', '2h', '1d', '30m'.");
    return;
  }
  state.customSchedule![step] = seconds;
  switch (step) {
    case "regStart":
      state.customScheduleStep = "regDuration";
      await api.sendMessage(chatId, "How long is registration open? (e.g. '24h')");
      return;
    case "regDuration":
      state.customScheduleStep = "staging";
      await api.sendMessage(chatId, "Staging buffer between registration close and game start? ('0' or '1h')");
      return;
    case "staging":
      state.customScheduleStep = "gameDuration";
      await api.sendMessage(chatId, "How long is the live game? (e.g. '24h', '7d')");
      return;
    case "gameDuration": {
      const c = state.customSchedule!;
      state.schedule = {
        regStart: c.regStart ?? 0,
        regDuration: c.regDuration ?? 0,
        staging: c.staging ?? 0,
        gameDuration: c.gameDuration!,
        submission: SUBMISSION_SECONDS,
      };
      state.customSchedule = undefined;
      state.customScheduleStep = undefined;
      state.customScheduleStyle = undefined;
      return moveToLeaderboard(api, state, chatId);
    }
  }
}

async function moveToLeaderboard(api: TelegramApi, state: State, chatId: string): Promise<void> {
  if (await maybeReturnToConfirm(api, state, chatId)) return;
  state.step = "leaderboard";
  await api.sendMessage(chatId, [
    `Schedule set.`,
    "",
    "Lower scores win? (yes/no — 'yes' for golf-style, 'no' for points-style)",
  ].join("\n"));
}

async function handleLeaderboard(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  // Two yes/no questions — leaderboard config is just (ascending, gameMustBeOver).
  // "Leaderboard size" isn't a contract field; it's distribution_count on EntryFee
  // and on distributed prizes, asked there if/when the user opts into a fee or
  // distributed prize.
  if (state.leaderboardAscending === undefined) {
    const b = parseYesNo(input);
    if (b === null) { await api.sendMessage(chatId, "Send 'yes' or 'no'."); return; }
    state.leaderboardAscending = b;
    await api.sendMessage(chatId, "Must the game be finished before submitting a score? (yes/no)");
    return;
  }
  if (state.gameMustBeOver === undefined) {
    const b = parseYesNo(input);
    if (b === null) { await api.sendMessage(chatId, "Send 'yes' or 'no'."); return; }
    state.gameMustBeOver = b;
    return moveToEntryFee(api, state, chatId);
  }
}

async function moveToEntryFee(api: TelegramApi, state: State, chatId: string): Promise<void> {
  if (await maybeReturnToConfirm(api, state, chatId)) return;
  state.step = "entryFeeChoice";
  await api.sendMessage(chatId, [
    "Add an entry fee?",
    "  1. No (free entry)",
    "  2. Yes",
    "",
    "Reply with a number.",
  ].join("\n"));
}

async function handleEntryFeeChoice(api: TelegramApi, config: Config, state: State, chatId: string, input: string): Promise<void> {
  const idx = parsePickIndex(input, 2);
  if (idx === null) { await api.sendMessage(chatId, "Reply 1 or 2."); return; }
  if (idx === 0) {
    return moveToPrizes(api, config, state, chatId);
  }
  state.step = "entryFeeToken";
  const tokens = tokensForChain(state.chain);
  await api.sendMessage(chatId, [
    "Pick the entry-fee token:",
    ...tokens.map((t, i) => `  ${i + 1}. ${t.symbol} (${t.name})`),
    "",
    "Reply with a number.",
  ].join("\n"));
}

async function handleEntryFeeToken(api: TelegramApi, _config: Config, state: State, chatId: string, input: string): Promise<void> {
  const tokens = tokensForChain(state.chain);
  const idx = parsePickIndex(input, tokens.length);
  if (idx === null) { await api.sendMessage(chatId, `Reply 1-${tokens.length}.`); return; }
  state.entryFeeToken = tokens[idx];
  state.step = "entryFeeAmount";
  await api.sendMessage(chatId, `Entry fee per player in ${state.entryFeeToken!.symbol}? (decimal, e.g. '0.5' or '10')`);
}

async function handleEntryFeeAmount(api: TelegramApi, _config: Config, state: State, chatId: string, input: string): Promise<void> {
  const raw = parseTokenAmount(input, state.entryFeeToken!.decimals);
  if (raw === null) {
    await api.sendMessage(chatId, "Couldn't parse that. Try '0.5' or '10'.");
    return;
  }
  state.entryFeeAmount = raw;

  // Game creator cut: pull the registry-side minimum from the whitelist
  // and use it as a floor. The contract's _assert_game_fee_met rejects
  // anything below this; the client matches with Math.max(minGameFee,
  // value). User can set it higher (revenue share with the game).
  const meta = gameMetadataFor(state.game!.contractAddress);
  const minPct = meta?.defaultGameFeePercentage ?? 1;
  state.entryFeeMinGameBps = Math.round(minPct * 100);

  state.step = "entryFeeGameShare";
  await api.sendMessage(
    chatId,
    [
      `Game creator cut? (% of each entry that goes to the game; minimum ${minPct}%, default ${minPct}%)`,
      "Send a number, or 'skip' to use the minimum.",
    ].join("\n"),
  );
}

async function handleEntryFeeGameShare(api: TelegramApi, _config: Config, state: State, chatId: string, input: string): Promise<void> {
  const minBps = state.entryFeeMinGameBps ?? 0;
  let bps: number;
  if (/^skip$/i.test(input.trim())) {
    bps = minBps;
  } else {
    const pct = parsePercent(input);
    if (pct === null) {
      await api.sendMessage(chatId, "Must be a number 0–100, or 'skip'.");
      return;
    }
    bps = Math.round(pct * 100);
    if (bps < minBps) {
      await api.sendMessage(
        chatId,
        `Below the registry minimum (${(minBps / 100).toFixed(2)}%). Send a higher number, or 'skip' for the minimum.`,
      );
      return;
    }
  }
  state.entryFeeGameBps = bps;
  state.step = "entryFeeCreatorShare";
  await api.sendMessage(
    chatId,
    `Tournament creator cut? (% of each entry that goes to you, default 0)`,
  );
}

async function handleEntryFeeCreatorShare(api: TelegramApi, _config: Config, state: State, chatId: string, input: string): Promise<void> {
  const pct = parsePercent(input);
  if (pct === null) {
    await api.sendMessage(chatId, "Must be a number 0–100. Try again.");
    return;
  }
  state.entryFeeCreatorBps = Math.round(pct * 100);
  state.step = "entryFeeRefundShare";
  await api.sendMessage(
    chatId,
    "Refund cut? (% of each entry refunded back to that entrant after the tournament, default 0)",
  );
}

async function handleEntryFeeRefundShare(api: TelegramApi, _config: Config, state: State, chatId: string, input: string): Promise<void> {
  const pct = parsePercent(input);
  if (pct === null) {
    await api.sendMessage(chatId, "Must be a number 0–100. Try again.");
    return;
  }
  // Validate the cumulative shares leave room for the leaderboard pool.
  const sum = (state.entryFeeCreatorBps ?? 0) + (state.entryFeeGameBps ?? 0) + Math.round(pct * 100);
  if (sum >= 10000) {
    await api.sendMessage(
      chatId,
      `Cuts add up to ${(sum / 100).toFixed(2)}% — that leaves nothing for the leaderboard pool. Lower one of them.`,
    );
    return;
  }
  state.entryFeeRefundBps = Math.round(pct * 100);
  state.step = "entryFeeDistCount";
  await api.sendMessage(chatId, "How many top placements share the prize pool? (e.g. 10)");
}

async function handleEntryFeeDistCount(api: TelegramApi, _config: Config, state: State, chatId: string, input: string): Promise<void> {
  if (!/^\d+$/.test(input)) { await api.sendMessage(chatId, "Send a positive integer."); return; }
  const n = Number(input);
  if (n <= 0 || n > 1000) {
    await api.sendMessage(chatId, "Must be 1–1000.");
    return;
  }
  state.entryFeeDistCount = n;
  state.step = "entryFeeDistType";
  await api.sendMessage(
    chatId,
    [
      "Distribution shape:",
      "  1. Linear (1st gets a bit more, decreases steadily)",
      "  2. Exponential (1st gets way more, drops off fast)",
      "  3. Uniform (equal split across all paid placements)",
      "",
      "Reply with a number.",
    ].join("\n"),
  );
}

async function handleEntryFeeDistType(api: TelegramApi, config: Config, state: State, chatId: string, input: string): Promise<void> {
  const idx = parsePickIndex(input, 3);
  if (idx === null) { await api.sendMessage(chatId, "Reply 1, 2, or 3."); return; }
  state.entryFeeDistType = idx === 0 ? "linear" : idx === 1 ? "exponential" : "uniform";
  if (state.entryFeeDistType === "uniform") {
    // Uniform has no weight — every paid placement gets the same share.
    return moveToPrizes(api, config, state, chatId);
  }
  // Linear / exponential: ask for weight + render preview curve.
  state.entryFeeDistWeight = 1;
  state.step = "entryFeeDistWeight";
  await renderDistributionCurve(api, state, chatId);
}

/**
 * Show the per-position percentages for the current distribution type +
 * weight. User can either accept ("ok") or send a new weight to recompute.
 *
 * Steeper exponentials (higher weight) concentrate more of the pool on the
 * top placements; the client's slider goes 0–10 with default 1.
 */
async function renderDistributionCurve(api: TelegramApi, state: State, chatId: string): Promise<void> {
  const distType = state.entryFeeDistType!;
  const count = state.entryFeeDistCount!;
  const weight = state.entryFeeDistWeight ?? 1;
  const percentages = calculateDistributionPercentages(count, weight, distType);

  // Render only the top N rows for chat brevity, but always include the last
  // row so the user can see where it bottoms out.
  const TOP_LIMIT = 10;
  const lines: string[] = [
    `Distribution: ${distType}, weight ${weight}, ${count} places.`,
    "Pool share per placement:",
  ];
  const showRow = (i: number) => {
    const pct = percentages[i] ?? 0;
    lines.push(`  ${i + 1}. ${pct.toFixed(2)}%`);
  };
  if (percentages.length <= TOP_LIMIT) {
    percentages.forEach((_, i) => showRow(i));
  } else {
    for (let i = 0; i < TOP_LIMIT - 1; i++) showRow(i);
    lines.push(`  …`);
    showRow(percentages.length - 1);
  }
  lines.push("");
  lines.push("Reply 'ok' to keep, or send a new weight (e.g. '2', '0.5') to recalculate.");
  await api.sendMessage(chatId, lines.join("\n"));
}

async function handleEntryFeeDistWeight(api: TelegramApi, config: Config, state: State, chatId: string, input: string): Promise<void> {
  if (/^ok$/i.test(input.trim())) {
    return moveToPrizes(api, config, state, chatId);
  }
  // Otherwise treat as a new weight value.
  const t = input.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) {
    await api.sendMessage(chatId, "Send 'ok' to keep, or a non-negative number.");
    return;
  }
  const w = Number(t);
  if (!Number.isFinite(w) || w < 0 || w > 100) {
    await api.sendMessage(chatId, "Weight must be 0–100.");
    return;
  }
  state.entryFeeDistWeight = w;
  await renderDistributionCurve(api, state, chatId);
}

/**
 * Per-position percentage shares of the leaderboard pool. Mirrors
 * metagame-sdk's calculateDistribution so the chat preview matches what the
 * contract will produce on chain. Returns percentages summing to 100,
 * length === positions.
 */
function calculateDistributionPercentages(
  positions: number,
  weight: number,
  distributionType: "linear" | "exponential" | "uniform",
): number[] {
  if (positions <= 0) return [];
  let raw: number[] = [];
  if (distributionType === "uniform") {
    raw = Array(positions).fill(1);
  } else if (distributionType === "linear") {
    for (let i = 0; i < positions; i++) {
      const positionValue = positions - i;
      raw.push(1 + (positionValue - 1) * (weight / 10));
    }
  } else {
    for (let i = 0; i < positions; i++) {
      raw.push(Math.pow(1 - i / positions, weight));
    }
  }
  const total = raw.reduce((a, b) => a + b, 0);
  if (total === 0) return Array(positions).fill(0);
  const bp = raw.map((d) => Math.floor((d / total) * 10000));
  const remaining = 10000 - bp.reduce((a, b) => a + b, 0);
  if (remaining !== 0) bp[0] = (bp[0] ?? 0) + remaining;
  return bp.map((b) => b / 100);
}

async function moveToPrizes(api: TelegramApi, config: Config, state: State, chatId: string): Promise<void> {
  if (await maybeReturnToConfirm(api, state, chatId)) return;
  state.step = "prizesChoice";
  if (!config.voyagerProxyUrl) {
    // Without Voyager, skip prize sponsorship in chat.
    await api.sendMessage(chatId, [
      "Sponsored prizes from chat aren't enabled (BUDOKAN_VOYAGER_PROXY_URL not set).",
      "You can add prizes after creation via budokan.gg.",
      "",
      "Continuing to confirmation…",
    ].join("\n"));
    return moveToConfirm(api, state, chatId);
  }
  await api.sendMessage(chatId, [
    "Add sponsored prizes from your wallet?",
    "  1. No",
    "  2. Yes (I'll show your token balances)",
    "",
    "Reply with a number.",
  ].join("\n"));
}

async function handlePrizesChoice(api: TelegramApi, config: Config, state: State, chatId: string, input: string): Promise<void> {
  const idx = parsePickIndex(input, 2);
  if (idx === null) { await api.sendMessage(chatId, "Reply 1 or 2."); return; }
  if (idx === 0) return moveToConfirm(api, state, chatId);

  const result = await resolveAccount(chatId, state.chain, config);
  if (!result.ok) {
    await api.sendMessage(chatId, "Need a connected session to read your balances. Run /connect first, then retry /create.");
    states.delete(chatId);
    return;
  }
  let balances: VoyagerTokenBalance[];
  try {
    balances = await fetchVoyagerBalances(config.voyagerProxyUrl, result.data.address, config.voyagerProxyToken);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch balances: ${formatError(error)}\nSkipping prize step.`);
    return moveToConfirm(api, state, chatId);
  }
  // Mainnet: only show tokens with a USD value (Voyager surfaces a lot of
  // spam tokens with no price). Sepolia: show everything since testnet
  // tokens typically have no USD value.
  const eligible = filterPrizeEligible(balances, state.chain);
  state.voyagerBalances = eligible;
  if (eligible.length === 0) {
    await api.sendMessage(chatId, "No non-zero balances found in your wallet. Skipping prizes.");
    return moveToConfirm(api, state, chatId);
  }
  state.step = "prizesPick";
  await api.sendMessage(chatId, [
    "Pick a token to sponsor (or 'done' to finish prizes):",
    ...eligible.map((b, i) => {
      const formatted = formatTokenAmount(b.balance, b.decimals);
      const usd = b.usdBalance !== undefined ? ` ($${b.usdBalance.toFixed(2)})` : "";
      return `  ${i + 1}. ${formatted} ${b.symbol}${usd}`;
    }),
    "",
    state.prizesSoFar.length > 0
      ? `(Already sponsoring: ${state.prizesSoFar.map((p) => `${formatTokenAmount(p.amount, p.token.decimals)} ${p.token.symbol}`).join(", ")})`
      : "Reply with a number, or 'done'.",
  ].join("\n"));
}

async function handlePrizesPick(api: TelegramApi, config: Config, state: State, chatId: string, input: string): Promise<void> {
  if (input.toLowerCase() === "done") {
    return moveToConfirm(api, state, chatId);
  }
  const balances = state.voyagerBalances ?? [];
  const idx = parsePickIndex(input, balances.length);
  if (idx === null) { await api.sendMessage(chatId, `Reply 1-${balances.length}, or 'done'.`); return; }
  state.pendingPrizeToken = balances[idx];
  state.step = "prizesAmount";
  await api.sendMessage(
    chatId,
    `Amount of ${state.pendingPrizeToken!.symbol} to sponsor? (decimal; you have ${formatTokenAmount(state.pendingPrizeToken!.balance, state.pendingPrizeToken!.decimals)} ${state.pendingPrizeToken!.symbol})`,
  );
}

async function handlePrizesAmount(api: TelegramApi, config: Config, state: State, chatId: string, input: string): Promise<void> {
  const token = state.pendingPrizeToken!;
  const raw = parseTokenAmount(input, token.decimals);
  if (raw === null) {
    await api.sendMessage(chatId, "Couldn't parse that. Try a decimal like '5' or '0.25'.");
    return;
  }
  if (BigInt(raw) > BigInt(token.balance)) {
    await api.sendMessage(chatId, "More than your balance. Try again.");
    return;
  }
  state.prizesSoFar.push({ token, amount: raw });
  state.pendingPrizeToken = undefined;
  // Loop back to the picker for another prize, or done.
  state.step = "prizesPick";
  await api.sendMessage(chatId, [
    `Added ${formatTokenAmount(raw, token.decimals)} ${token.symbol}.`,
    "",
    "Pick another token, or send 'done':",
    ...(state.voyagerBalances ?? []).map((b, i) => {
      const formatted = formatTokenAmount(b.balance, b.decimals);
      return `  ${i + 1}. ${formatted} ${b.symbol}`;
    }),
  ].join("\n"));
}

async function moveToConfirm(api: TelegramApi, state: State, chatId: string): Promise<void> {
  state.step = "confirm";
  state.editing = false;
  const sectionList = SECTIONS.map((s, i) => `  ${i + 1}. ${s.title}`).join("\n");
  await api.sendMessage(chatId, [
    formatSummary(state),
    "",
    "Sections (use 'edit N' to change one):",
    sectionList,
    "",
    "Reply 'create' to submit, 'edit N' to change a section, '/back' to revisit the last section, or /cancel.",
  ].join("\n"));
}

async function handleConfirm(api: TelegramApi, config: Config, state: State, chatId: string, input: string): Promise<void> {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "create") {
    states.delete(chatId);
    return execute(api, config, chatId, state);
  }
  // edit N — jump to that section's first prompt.
  const editMatch = trimmed.match(/^edit\s+(\d+)$/);
  if (editMatch) {
    const n = Number(editMatch[1]);
    if (!Number.isInteger(n) || n < 1 || n > SECTIONS.length) {
      await api.sendMessage(chatId, `Section must be 1–${SECTIONS.length}.`);
      return;
    }
    return editSection(api, state, chatId, SECTIONS[n - 1]!);
  }
  await api.sendMessage(
    chatId,
    `Reply 'create' to submit, 'edit N' (1–${SECTIONS.length}) to change a section, '/back' for the last section, or /cancel.`,
  );
}

async function execute(api: TelegramApi, config: Config, chatId: string, state: State): Promise<void> {
  const result = await resolveAccount(chatId, state.chain, config);
  if (!result.ok) {
    await api.sendMessage(chatId, `Not connected on ${state.chain} — run /connect.`);
    return;
  }
  const budokanAddress = config.budokanAddress ?? CHAINS[state.chain]?.budokanAddress;
  if (!budokanAddress) {
    await api.sendMessage(chatId, "Internal error: no Budokan address.");
    return;
  }
  const sched = state.schedule!;
  const entryFee = buildEntryFeeArgs(state);
  const args: CreateTournamentArgs = {
    creatorRewardsAddress: result.data.address,
    name: state.name!,
    description: state.description ?? "",
    gameAddress: state.game!.contractAddress,
    settingsId: state.settingsId!,
    schedule: {
      registrationStartDelay: sched.regStart,
      registrationEndDelay: sched.regStart + sched.regDuration,
      gameStartDelay: sched.regStart + sched.regDuration + sched.staging,
      gameEndDelay: sched.regStart + sched.regDuration + sched.staging + sched.gameDuration,
      submissionDuration: sched.submission,
    },
    leaderboard: { ascending: state.leaderboardAscending!, gameMustBeOver: state.gameMustBeOver! },
    entryFee,
  };
  // Defining an entry fee in create_tournament doesn't move funds (the fee
  // gets paid by entrants, not the creator), so this stays a single
  // sessioned call. Sponsored prizes still need a separate add_prize
  // round-trip via the Mini App tx flow because they DO move user funds —
  // gathered above but not submitted here yet.
  const call = buildCreateTournamentCall(budokanAddress, args);
  await api.sendMessage(chatId, "Submitting tournament…");
  try {
    const tx = await result.data.account.execute([call]);
    const lines = [
      `Tournament submitted ✓`,
      `tx: ${tx.transaction_hash}`,
    ];
    if (state.prizesSoFar.length > 0) {
      lines.push(
        "",
        "Note: sponsored prizes you picked aren't sent yet — that's a separate signed tx (per-token approve + add_prize). Open the tournament on budokan.gg once it appears in the indexer to add them.",
      );
    }
    lines.push("", "It will appear in /tournaments shortly.");
    await api.sendMessage(chatId, lines.join("\n"));
  } catch (error) {
    await api.sendMessage(chatId, `Tournament creation failed: ${formatError(error)}`);
  }
}

/** Assemble EntryFeeArgs from state, or undefined if the user opted out. */
function buildEntryFeeArgs(state: State): EntryFeeArgs | undefined {
  if (!state.entryFeeToken || !state.entryFeeAmount) return undefined;
  const distType = state.entryFeeDistType ?? "exponential";
  const distribution: DistributionSpec =
    distType === "uniform"
      ? { kind: "uniform" }
      : { kind: distType, weight: state.entryFeeDistWeight ?? 1 };
  return {
    tokenAddress: state.entryFeeToken.address,
    amount: state.entryFeeAmount,
    tournamentCreatorShare: state.entryFeeCreatorBps ?? 0,
    gameCreatorShare: state.entryFeeGameBps ?? 0,
    refundShare: state.entryFeeRefundBps ?? 0,
    distribution,
    distributionCount: state.entryFeeDistCount ?? 10,
  };
}

// --- formatters ---

function formatSummary(s: State): string {
  const sched = s.schedule!;
  const isOpen = sched.regStart === 0 && sched.regDuration === 0;
  const lines = [
    "Ready to create:",
    `  Game: ${s.game!.name}`,
    `  Name: ${s.name}`,
    `  Description: ${s.description || "(none)"}`,
    `  Settings: ${s.settingsName}`,
    `  Registration: ${isOpen ? "open (players can join during play)" : `fixed (opens in ${formatDuration(sched.regStart)}, lasts ${formatDuration(sched.regDuration)})`}`,
  ];
  if (sched.staging > 0) {
    lines.push(`  Staging delay: ${formatDuration(sched.staging)}`);
  }
  lines.push(
    `  Live game: ${formatDuration(sched.gameDuration)}`,
    `  Submission window: ${formatDuration(sched.submission)}`,
    `  Lower scores win: ${s.leaderboardAscending ? "yes" : "no"}`,
    `  Require game over: ${s.gameMustBeOver ? "yes" : "no"}`,
  );
  if (s.entryFeeToken && s.entryFeeAmount) {
    const creator = (s.entryFeeCreatorBps ?? 0) / 100;
    const game = (s.entryFeeGameBps ?? 0) / 100;
    const refund = (s.entryFeeRefundBps ?? 0) / 100;
    const pool = 100 - creator - game - refund;
    lines.push(`  Entry fee: ${formatTokenAmount(s.entryFeeAmount, s.entryFeeToken.decimals)} ${s.entryFeeToken.symbol}`);
    lines.push(`    Tournament creator: ${creator}%`);
    lines.push(`    Game creator: ${game}%`);
    lines.push(`    Refund per entrant: ${refund}%`);
    const distSuffix = s.entryFeeDistType === "uniform"
      ? ""
      : `, weight ${s.entryFeeDistWeight ?? 1}`;
    lines.push(`    Leaderboard pool: ${pool.toFixed(2)}% to top ${s.entryFeeDistCount} via ${s.entryFeeDistType}${distSuffix}`);
  } else {
    lines.push(`  Entry fee: none`);
  }
  if (s.prizesSoFar.length > 0) {
    lines.push("  Prizes:");
    for (const p of s.prizesSoFar) {
      lines.push(`    - ${formatTokenAmount(p.amount, p.token.decimals)} ${p.token.symbol}`);
    }
  }
  return lines.join("\n");
}

// --- section editing (edit N + /back) ---

interface SectionDef {
  id: SectionId;
  title: string;
  firstStep: Step;
  // Steps that fall under this section (used to determine "current section"
  // for /back, and to clear-on-edit for edit N).
  steps: readonly Step[];
  // State fields the editor wipes when re-entering this section. Wiping
  // forces the walk-forward path to re-ask. Downstream sections' fields are
  // intentionally NOT wiped — user can edit those separately if they go
  // stale (e.g. settings after a game change).
  clear: (keyof State)[];
}

const SECTIONS: readonly SectionDef[] = [
  {
    id: "game",
    title: "Game",
    firstStep: "game",
    steps: ["game"],
    clear: ["game"],
  },
  {
    id: "metadata",
    title: "Name + description",
    firstStep: "name",
    steps: ["name", "description"],
    clear: ["name", "description"],
  },
  {
    id: "settings",
    title: "Settings",
    firstStep: "settings",
    steps: ["settings"],
    clear: ["settingsId", "settingsName", "settingsPage"],
  },
  {
    id: "schedule",
    title: "Schedule",
    firstStep: "schedule",
    steps: ["schedule", "scheduleCustom"],
    clear: ["schedule", "customSchedule", "customScheduleStep", "customScheduleStyle"],
  },
  {
    id: "leaderboard",
    title: "Leaderboard rules",
    firstStep: "leaderboard",
    steps: ["leaderboard"],
    clear: ["leaderboardAscending", "gameMustBeOver"],
  },
  {
    id: "entryFee",
    title: "Entry fee",
    firstStep: "entryFeeChoice",
    steps: [
      "entryFeeChoice", "entryFeeToken", "entryFeeAmount",
      "entryFeeGameShare", "entryFeeCreatorShare", "entryFeeRefundShare",
      "entryFeeDistCount", "entryFeeDistType", "entryFeeDistWeight",
    ],
    clear: [
      "entryFeeToken", "entryFeeAmount", "entryFeeCreatorBps",
      "entryFeeGameBps", "entryFeeMinGameBps", "entryFeeRefundBps",
      "entryFeeDistType", "entryFeeDistCount", "entryFeeDistWeight",
    ],
  },
  {
    id: "prizes",
    title: "Sponsored prizes",
    firstStep: "prizesChoice",
    steps: ["prizesChoice", "prizesPick", "prizesAmount"],
    clear: ["prizesSoFar", "voyagerBalances", "pendingPrizeToken"],
  },
] as const;

function sectionForStep(step: Step): SectionDef | undefined {
  return SECTIONS.find((s) => s.steps.includes(step));
}

function sectionById(id: SectionId): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}

/**
 * Re-enter a section. Clears that section's fields, sets the step to its
 * first prompt, marks editing=true so the section's exit handler will jump
 * back to confirmation instead of advancing.
 *
 * Section-level prizesSoFar reset specifically rebuilds the empty array so
 * the field type stays correct (it's mandatory, not optional).
 */
async function editSection(api: TelegramApi, state: State, chatId: string, section: SectionDef): Promise<void> {
  for (const field of section.clear) {
    if (field === "prizesSoFar") {
      state.prizesSoFar = [];
    } else {
      delete (state as Record<keyof State, unknown>)[field];
    }
  }
  state.editing = true;
  state.step = section.firstStep;
  await renderStepPrompt(api, state, chatId, section.firstStep);
}

/**
 * /back command — handled by telegram.ts and routed here when a /create
 * flow is pending. Edits the section the user is currently in (or the last
 * section, if they're already at the confirmation screen).
 */
export async function back(api: TelegramApi, chatId: string): Promise<void> {
  const state = states.get(chatId);
  if (!state) return;
  if (state.step === "confirm") {
    const last = SECTIONS[SECTIONS.length - 1]!;
    return editSection(api, state, chatId, last);
  }
  const section = sectionForStep(state.step);
  if (!section) return;
  await editSection(api, state, chatId, section);
}

/**
 * Render the entry prompt for a step. Used after edit/back to re-emit
 * the right question without going through a transition function.
 */
async function renderStepPrompt(api: TelegramApi, state: State, chatId: string, step: Step): Promise<void> {
  switch (step) {
    case "game":
      await api.sendMessage(chatId, [
        "Pick a game:",
        ...state.gamesList.map((g, i) => `  ${i + 1}. ${g.name} — ${shortHex(g.contractAddress)}`),
        "",
        "Reply with a number.",
      ].join("\n"));
      return;
    case "name":
      await api.sendMessage(chatId, "Tournament name? (≤31 ASCII characters)");
      return;
    case "description":
      await api.sendMessage(chatId, "Description? (free text, or send 'skip')");
      return;
    case "settings":
      // Pulls a fresh first page; same prompt as the natural entry path.
      return renderSettingsPage(api, state, chatId, 0);
    case "schedule":
      return moveToScheduleNoEditCheck(api, state, chatId);
    case "leaderboard":
      await api.sendMessage(chatId, "Lower scores win? (yes/no — 'yes' for golf-style, 'no' for points-style)");
      return;
    case "entryFeeChoice":
      await api.sendMessage(chatId, [
        "Add an entry fee?",
        "  1. No (free entry)",
        "  2. Yes",
        "",
        "Reply with a number.",
      ].join("\n"));
      return;
    case "prizesChoice":
      // moveToPrizes already handles "no Voyager → skip" semantics; reuse.
      return moveToPrizesNoEditCheck(api, state, chatId);
    default:
      // Mid-section steps shouldn't be re-entered directly via edit/back —
      // we always restart at the section's firstStep. Fall back to an
      // informational message just in case.
      await api.sendMessage(chatId, `Resuming at step '${step}'. Continue answering, or /cancel.`);
  }
}

// Versions that skip the editing-check guard, used by renderStepPrompt's
// re-entry into already-edit-aware transitions.
async function moveToScheduleNoEditCheck(api: TelegramApi, state: State, chatId: string): Promise<void> {
  state.step = "schedule";
  const lines: string[] = [
    "Pick a schedule preset.",
    "",
    "Fixed registration (registration window closes before play starts):",
    ...FIXED_PRESETS.map((p, i) => `  ${i + 1}. ${p.name}`),
    "",
    "Open registration (players can join throughout play):",
    ...OPEN_PRESETS.map((p, i) => `  ${FIXED_PRESETS.length + i + 1}. ${p.name}`),
    "",
    `  ${SCHEDULE_PRESETS.length + 1}. Custom (I'll ask for each window)`,
    "",
    "Reply with a number.",
  ];
  await api.sendMessage(chatId, lines.join("\n"));
}

async function moveToPrizesNoEditCheck(api: TelegramApi, state: State, chatId: string): Promise<void> {
  state.step = "prizesChoice";
  await api.sendMessage(chatId, [
    "Add sponsored prizes from your wallet?",
    "  1. No",
    "  2. Yes (I'll show your token balances)",
    "",
    "Reply with a number.",
  ].join("\n"));
}

// --- helpers ---

function parsePickIndex(input: string, n: number): number | null {
  if (!/^\d+$/.test(input)) return null;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 1 || v > n) return null;
  return v - 1;
}

function parseDuration(input: string, allowZero: boolean): number | null {
  const t = input.trim().toLowerCase();
  if (allowZero && (t === "now" || t === "0")) return 0;
  const match = t.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) {
    if (/^\d+$/.test(t)) return Number(t);
    return null;
  }
  const value = Number(match[1]);
  const unit = match[2];
  const mul = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return value * mul;
}

function formatDuration(seconds: number): string {
  if (seconds === 0) return "now/0s";
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// Parse a percentage between 0 and 100 (inclusive). Accepts "5", "0.5",
// "10.25". Returns null for negatives, non-numerics, or > 100.
function parsePercent(s: string): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

function parseYesNo(s: string): boolean | null {
  const t = s.trim().toLowerCase();
  if (["y", "yes", "true"].includes(t)) return true;
  if (["n", "no", "false"].includes(t)) return false;
  return null;
}

// Parse a decimal token amount into raw u256 (string of decimal digits). Returns
// null on parse failure. Accepts "1", "0.5", "10.123456789".
function parseTokenAmount(input: string, decimals: number): string | null {
  const t = input.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  const padded = frac.padEnd(decimals, "0");
  const combined = (whole === "" ? "0" : whole) + padded;
  // Strip leading zeros, but keep at least one digit.
  const stripped = combined.replace(/^0+/, "") || "0";
  return stripped;
}

function formatTokenAmount(rawAmount: string, decimals: number): string {
  let bi: bigint;
  try { bi = BigInt(rawAmount); } catch { return rawAmount; }
  if (decimals === 0) return bi.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = (bi / divisor).toString();
  const frac = (bi % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// Shortened hex form for displaying contract addresses inline. e.g.
// 0x07ae26eecf027… → "0x07ae26ee…c89202831". Long enough that two games
// with similar prefixes are still distinguishable.
function shortHex(value: string): string {
  if (!value || value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
