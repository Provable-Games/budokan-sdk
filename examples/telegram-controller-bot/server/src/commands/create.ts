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
} from "../budokan-calls.ts";
import { resolveAccount } from "../controller-account.ts";
import { CHAINS } from "@provable-games/budokan-sdk";

import { gamesForChain, type Game } from "../catalog/games.ts";
import { tokensForChain, findKnownToken, type Erc20Token } from "../catalog/tokens.ts";
import { fetchSettings, type GameSettingDetails } from "../catalog/settings.ts";
import { fetchVoyagerBalances, type VoyagerTokenBalance } from "../voyager.ts";

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
  | "prizesChoice"
  | "prizesPick"
  | "prizesAmount"
  | "confirm";

type SchedulePreset = {
  name: string;
  regStart: number;
  regDuration: number;
  staging: number;
  gameDuration: number;
  submission: number;
};

const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { name: "Quickfire (1h reg / 1h play / 1h submit)",
    regStart: 0, regDuration: 3600, staging: 0, gameDuration: 3600, submission: 3600 },
  { name: "Same-day (1h reg / 8h play / 4h submit)",
    regStart: 0, regDuration: 3600, staging: 0, gameDuration: 28800, submission: 14400 },
  { name: "Standard (24h reg / 24h play / 24h submit)",
    regStart: 0, regDuration: 86400, staging: 0, gameDuration: 86400, submission: 86400 },
  { name: "Weekend (24h reg / 48h play / 24h submit)",
    regStart: 0, regDuration: 86400, staging: 0, gameDuration: 172800, submission: 86400 },
  { name: "Weeklong (24h reg / 7d play / 24h submit)",
    regStart: 0, regDuration: 86400, staging: 0, gameDuration: 604800, submission: 86400 },
];

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

interface State {
  step: Step;
  chain: Chain;
  // Filled progressively.
  game?: Game;
  name?: string;
  description?: string;
  settingsId?: number;
  settingsName?: string;
  settingsPage?: SettingsPage;
  schedule?: { regStart: number; regDuration: number; staging: number; gameDuration: number; submission: number };
  customSchedule?: Partial<{ regStart: number; regDuration: number; staging: number; gameDuration: number; submission: number }>;
  customScheduleStep?: "regStart" | "regDuration" | "staging" | "gameDuration" | "submission";
  leaderboardSize?: number;
  leaderboardAscending?: boolean;
  gameMustBeOver?: boolean;
  // Entry fee
  entryFeeToken?: Erc20Token;
  entryFeeAmount?: string;     // raw u256 (decimal string)
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
  const games = gamesForChain(chain);
  if (games.length === 0) {
    await api.sendMessage(chatId, `No games configured for ${chain}. Contact the bot operator.`);
    return;
  }
  states.set(chatId, { step: "game", chain, prizesSoFar: [] });
  await api.sendMessage(chatId, [
    `Let's create a tournament on ${chain}. /cancel to abort.`,
    "",
    "Pick a game:",
    ...games.map((g, i) => `  ${i + 1}. ${g.name}`),
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
  const games = gamesForChain(state.chain);
  const idx = parsePickIndex(input, games.length);
  if (idx === null) {
    await api.sendMessage(chatId, `Reply with a number 1-${games.length}, or /cancel.`);
    return;
  }
  state.game = games[idx];
  state.step = "name";
  await api.sendMessage(chatId, `Selected: ${state.game!.name}\n\nTournament name? (≤31 ASCII characters)`);
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
  state.step = "schedule";
  await api.sendMessage(chatId, [
    `Settings: ${state.settingsName}`,
    "",
    "Pick a schedule preset:",
    ...SCHEDULE_PRESETS.map((p, i) => `  ${i + 1}. ${p.name}`),
    `  ${SCHEDULE_PRESETS.length + 1}. Custom (I'll ask for each window)`,
    "",
    "Reply with a number.",
  ].join("\n"));
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
  // Custom path.
  state.step = "scheduleCustom";
  state.customSchedule = {};
  state.customScheduleStep = "regStart";
  await api.sendMessage(chatId, "When does registration open? Send 'now', or '2h', '30m', '1d'.");
}

async function handleScheduleCustom(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  const step = state.customScheduleStep!;
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
    case "gameDuration":
      state.customScheduleStep = "submission";
      await api.sendMessage(chatId, "Submission window after the game ends? (e.g. '24h')");
      return;
    case "submission": {
      const c = state.customSchedule!;
      state.schedule = {
        regStart: c.regStart!,
        regDuration: c.regDuration!,
        staging: c.staging!,
        gameDuration: c.gameDuration!,
        submission: c.submission!,
      };
      state.customSchedule = undefined;
      state.customScheduleStep = undefined;
      return moveToLeaderboard(api, state, chatId);
    }
  }
}

async function moveToLeaderboard(api: TelegramApi, state: State, chatId: string): Promise<void> {
  state.step = "leaderboard";
  await api.sendMessage(chatId, [
    `Schedule set.`,
    "",
    "Leaderboard size? (number of placements that count, e.g. 10)",
  ].join("\n"));
}

async function handleLeaderboard(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  // We collect leaderboard size, ascending, gameMustBeOver in three quick yes/no steps.
  if (state.leaderboardSize === undefined) {
    const n = parseUint(input);
    if (n === null || n === 0 || n > 1000) {
      await api.sendMessage(chatId, "Must be 1–1000.");
      return;
    }
    state.leaderboardSize = n;
    await api.sendMessage(chatId, "Lower scores win? (yes/no — 'yes' for golf-style, 'no' for points-style)");
    return;
  }
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

async function handleEntryFeeAmount(api: TelegramApi, config: Config, state: State, chatId: string, input: string): Promise<void> {
  const raw = parseTokenAmount(input, state.entryFeeToken!.decimals);
  if (raw === null) {
    await api.sendMessage(chatId, "Couldn't parse that. Try '0.5' or '10'.");
    return;
  }
  state.entryFeeAmount = raw;
  await moveToPrizes(api, config, state, chatId);
}

async function moveToPrizes(api: TelegramApi, config: Config, state: State, chatId: string): Promise<void> {
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
    balances = await fetchVoyagerBalances(config.voyagerProxyUrl, result.data.address);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch balances: ${formatError(error)}\nSkipping prize step.`);
    return moveToConfirm(api, state, chatId);
  }
  // Filter to tokens with non-zero balance and skip the entry-fee token if any
  // (it's the same token a sponsor would use; allowed but not displayed twice).
  const eligible = balances.filter((b) => BigInt(b.balance) > 0n);
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
  await api.sendMessage(chatId, formatSummary(state) + "\n\nReply 'create' to submit, or /cancel.");
}

async function handleConfirm(api: TelegramApi, config: Config, state: State, chatId: string, input: string): Promise<void> {
  if (!/^create$/i.test(input)) {
    await api.sendMessage(chatId, "Reply 'create' to submit, or /cancel.");
    return;
  }
  states.delete(chatId);
  await execute(api, config, chatId, state);
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
  };
  // Note: this PR ships the create-without-fee/prizes path via session.
  // Entry fee + sponsored prizes still need add_prize follow-ups (separate
  // tx because tournament_id isn't known until create_tournament confirms)
  // — those land in the next PR alongside the per-tx Mini App route for
  // approve calls. For now the chat creates the tournament; we tell the
  // user to set fees/prizes via budokan.gg afterward if they picked them.
  const call = buildCreateTournamentCall(budokanAddress, args);
  await api.sendMessage(chatId, "Submitting tournament…");
  try {
    const tx = await result.data.account.execute([call]);
    const lines = [
      `Tournament submitted ✓`,
      `tx: ${tx.transaction_hash}`,
    ];
    if (state.entryFeeAmount || state.prizesSoFar.length > 0) {
      lines.push(
        "",
        "Note: entry-fee + sponsored-prize setup at create time isn't shipped yet — open the tournament on budokan.gg once it appears in the indexer to add those.",
      );
    }
    lines.push("", "It will appear in /tournaments shortly.");
    await api.sendMessage(chatId, lines.join("\n"));
  } catch (error) {
    await api.sendMessage(chatId, `Tournament creation failed: ${formatError(error)}`);
  }
}

// --- formatters ---

function formatSummary(s: State): string {
  const sched = s.schedule!;
  const lines = [
    "Ready to create:",
    `  Game: ${s.game!.name}`,
    `  Name: ${s.name}`,
    `  Description: ${s.description || "(none)"}`,
    `  Settings: ${s.settingsName}`,
    `  Registration opens: ${formatDuration(sched.regStart)}`,
    `  Registration window: ${formatDuration(sched.regDuration)}`,
    `  Staging: ${formatDuration(sched.staging)}`,
    `  Live game: ${formatDuration(sched.gameDuration)}`,
    `  Submission: ${formatDuration(sched.submission)}`,
    `  Leaderboard size: ${s.leaderboardSize}`,
    `  Lower scores win: ${s.leaderboardAscending ? "yes" : "no"}`,
    `  Require game over: ${s.gameMustBeOver ? "yes" : "no"}`,
  ];
  if (s.entryFeeToken && s.entryFeeAmount) {
    lines.push(`  Entry fee: ${formatTokenAmount(s.entryFeeAmount, s.entryFeeToken.decimals)} ${s.entryFeeToken.symbol}`);
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

function parseUint(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
