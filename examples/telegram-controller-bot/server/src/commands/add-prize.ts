// /add-prize <tournamentId> — sponsor an ERC20 prize for an existing tournament.
//
// Architecture mirrors /enter for paid tournaments: bot collects the prize
// spec via multi-turn Q&A, builds [approve, add_prize] calls, mints a
// tx-mode handshake token, and sends a web_app button to the Mini App. The
// user signs in their browser (Cartridge keychain modal) — required because
// add_prize moves the user's funds via approve(), which the bot's session
// deliberately doesn't authorize.
//
// ERC721 prize sponsorship is intentionally out of scope (token-id picker
// from a Voyager NFT call is a substantial extra UX layer; defer to
// budokan.gg for that case).

import { CHAINS, createBudokanClient } from "@provable-games/budokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import type { HandshakeStore } from "../handshake.ts";
import { TelegramApi, webAppButton } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import {
  buildAddPrizeCall,
  buildErc20ApproveCall,
  type AddPrizeArgs,
  type Call,
  type DistributionSpec,
} from "../budokan-calls.ts";
import { fetchVoyagerBalances, type VoyagerTokenBalance } from "../voyager.ts";
import { gamesForChain } from "../catalog/games.ts";

type Step =
  | "tournamentPick"
  | "tokenPick"
  | "amount"
  | "split"
  | "distCount"
  | "distType"
  | "distWeight"
  | "confirm";

interface State {
  step: Step;
  chain: Chain;
  // Set once the tournament has been resolved — either from /add_prize <id>
  // or after the picker step.
  tournamentId?: string;
  tournamentName?: string;
  sponsorAddress?: string;
  balances?: VoyagerTokenBalance[];
  // Picker-step scratch: tournaments displayed to the user. Cleared after pick.
  pickerTournaments?: Array<{ id: string; name: string; gameAddress: string; entryCount: number }>;
  pickerGameNames?: Map<string, string>;
  // Filled progressively after token pick
  token?: VoyagerTokenBalance;
  amountRaw?: string;        // u128 raw decimal string
  splitChoice?: "single" | "distributed";
  distCount?: number;
  distType?: "linear" | "exponential" | "uniform";
  distWeight?: number;       // client-units, ×10 on chain
}

const states = new Map<string, State>();

export function isPending(chatId: string): boolean {
  return states.has(chatId);
}

export function cancel(chatId: string): boolean {
  return states.delete(chatId);
}

/**
 * Kick off /add_prize [tournamentId]. With an id, validates + advances to
 * token picker. Without one, fetches non-finalized tournaments and shows a
 * tournament picker first; the picker's selection then drives the same
 * balance/token-picker flow.
 */
export async function start(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
  args: string[],
): Promise<void> {
  if (!config.voyagerProxyUrl || !config.voyagerProxyToken) {
    await api.sendMessage(
      chatId,
      "Sponsoring prizes from chat needs the Voyager proxy configured (BUDOKAN_VOYAGER_PROXY_URL + BUDOKAN_VOYAGER_PROXY_TOKEN). Use budokan.gg for now.",
    );
    return;
  }

  // Need a session to (a) sign add_prize, (b) know the sponsor address,
  // (c) fetch balances tied to that address. Resolved up front so both
  // paths (direct-id and picker) fail fast if not connected.
  const session = await resolveAccount(chatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(chatId, `Not connected on ${chain} — run /connect first.`);
    return;
  }

  // Explicit id: skip the picker.
  if (args.length === 1 && args[0] && /^\d+$/.test(args[0])) {
    return resolveTournamentAndShowTokens(api, config, chatId, chain, session.data.address, args[0]);
  }
  if (args.length !== 0) {
    await api.sendMessage(chatId, "Usage: /add_prize [tournamentId]\nWith no id I'll show a picker.");
    return;
  }

  // No-args: show picker of non-finalized tournaments.
  const sdk = sdkClient(config, chain);
  const phasesToShow = ["scheduled", "registration", "staging", "live", "submission"] as const;
  let pool: Array<{ id: string; name: string; gameAddress: string; entryCount: number }>;
  try {
    const lists = await Promise.all(
      phasesToShow.map((phase) =>
        sdk.getTournaments({ phase, limit: 25, sort: "created_at" }).then((r) => r.data),
      ),
    );
    const byId = new Map<string, { id: string; name: string; gameAddress: string; entryCount: number }>();
    for (const list of lists) {
      for (const t of list) {
        byId.set(t.id, {
          id: t.id,
          name: t.name || "(unnamed)",
          gameAddress: t.gameAddress,
          entryCount: t.entryCount,
        });
      }
    }
    pool = Array.from(byId.values()).sort((a, b) => Number(b.id) - Number(a.id));
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch tournaments: ${formatError(error)}`);
    return;
  }
  if (pool.length === 0) {
    await api.sendMessage(chatId, `No active tournaments on ${chain} to sponsor.`);
    return;
  }
  const gameNames = await buildGameNameMap(chain);

  states.set(chatId, {
    step: "tournamentPick",
    chain,
    sponsorAddress: session.data.address,
    pickerTournaments: pool,
    pickerGameNames: gameNames,
  });

  const lines = [
    `Pick a tournament to sponsor on ${chain}:`,
    "",
    ...pool.map((t, i) => {
      const game = gameNames.get(t.gameAddress.toLowerCase()) ?? shortAddr(t.gameAddress);
      return `  ${i + 1}. #${t.id} ${t.name} — ${game} · ${t.entryCount} ${t.entryCount === 1 ? "entry" : "entries"}`;
    }),
    "",
    "Reply with a number, or /cancel.",
  ];
  await api.sendMessage(chatId, lines.join("\n"));
}

/**
 * Looks up the tournament by id, fetches balances, sets state, and prompts
 * for token selection. Shared by both the direct-id path and the picker's
 * selection callback so the user reaches the same place either way.
 */
async function resolveTournamentAndShowTokens(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
  sponsorAddress: string,
  tournamentId: string,
): Promise<void> {
  // Verify tournament exists + grab name for the summary.
  let tournament;
  try {
    tournament = await sdkClient(config, chain).getTournament(tournamentId);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch tournament: ${formatError(error)}`);
    return;
  }
  if (!tournament) {
    await api.sendMessage(chatId, `Tournament ${tournamentId} not found.`);
    return;
  }

  let balances: VoyagerTokenBalance[];
  try {
    balances = await fetchVoyagerBalances(
      config.voyagerProxyUrl,
      sponsorAddress,
      config.voyagerProxyToken,
    );
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch your balances: ${formatError(error)}`);
    return;
  }
  const eligible = balances.filter((b) => BigInt(b.balance) > 0n);
  if (eligible.length === 0) {
    await api.sendMessage(chatId, "No non-zero ERC-20 balances found in your wallet. Nothing to sponsor.");
    return;
  }

  states.set(chatId, {
    step: "tokenPick",
    chain,
    tournamentId,
    tournamentName: tournament.name || "(unnamed)",
    sponsorAddress,
    balances: eligible,
  });

  await api.sendMessage(chatId, [
    `Sponsor a prize for tournament ${tournamentId} — ${tournament.name || "(unnamed)"}.`,
    "Pick a token to sponsor:",
    ...eligible.map((b, i) => {
      const formatted = formatTokenAmount(b.balance, b.decimals);
      const usd = b.usdBalance !== undefined ? ` ($${b.usdBalance.toFixed(2)})` : "";
      return `  ${i + 1}. ${formatted} ${b.symbol}${usd}`;
    }),
    "",
    "Reply with a number, or /cancel.",
  ].join("\n"));
}

export async function handleAnswer(
  api: TelegramApi,
  config: Config,
  handshakes: HandshakeStore,
  chatId: string,
  text: string,
): Promise<void> {
  const state = states.get(chatId);
  if (!state) return;
  const trimmed = text.trim();

  switch (state.step) {
    case "tournamentPick":
      return handleTournamentPick(api, config, state, chatId, trimmed);
    case "tokenPick":
      return handleTokenPick(api, state, chatId, trimmed);
    case "amount":
      return handleAmount(api, state, chatId, trimmed);
    case "split":
      return handleSplit(api, state, chatId, trimmed);
    case "distCount":
      return handleDistCount(api, state, chatId, trimmed);
    case "distType":
      return handleDistType(api, state, chatId, trimmed);
    case "distWeight":
      return handleDistWeight(api, state, chatId, trimmed);
    case "confirm":
      return handleConfirm(api, config, handshakes, state, chatId, trimmed);
  }
}

async function handleTournamentPick(
  api: TelegramApi,
  config: Config,
  state: State,
  chatId: string,
  input: string,
): Promise<void> {
  const pool = state.pickerTournaments ?? [];
  const idx = parsePickIndex(input, pool.length);
  if (idx === null) {
    await api.sendMessage(chatId, `Reply 1-${pool.length}, or /cancel.`);
    return;
  }
  const chosen = pool[idx]!;
  // Clear the picker scratch fields; the rest of the flow only cares
  // about resolved state.
  state.pickerTournaments = undefined;
  state.pickerGameNames = undefined;
  await resolveTournamentAndShowTokens(api, config, chatId, state.chain, state.sponsorAddress!, chosen.id);
}

async function handleTokenPick(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  const balances = state.balances ?? [];
  const idx = parsePickIndex(input, balances.length);
  if (idx === null) {
    await api.sendMessage(chatId, `Reply 1-${balances.length}, or /cancel.`);
    return;
  }
  state.token = balances[idx];
  state.step = "amount";
  await api.sendMessage(
    chatId,
    `Amount of ${state.token!.symbol} to sponsor? (decimal; you have ${formatTokenAmount(state.token!.balance, state.token!.decimals)} ${state.token!.symbol})`,
  );
}

async function handleAmount(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  const token = state.token!;
  const raw = parseTokenAmount(input, token.decimals);
  if (raw === null) {
    await api.sendMessage(chatId, "Couldn't parse that. Try a decimal like '5' or '0.25'.");
    return;
  }
  if (BigInt(raw) > BigInt(token.balance)) {
    await api.sendMessage(chatId, "More than your balance. Try again.");
    return;
  }
  if (BigInt(raw) === 0n) {
    await api.sendMessage(chatId, "Amount must be positive.");
    return;
  }
  state.amountRaw = raw;
  state.step = "split";
  await api.sendMessage(chatId, [
    "How is this prize awarded?",
    "  1. Single payout (winner takes all)",
    "  2. Distributed across top N placements",
    "",
    "Reply with a number.",
  ].join("\n"));
}

async function handleSplit(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  const idx = parsePickIndex(input, 2);
  if (idx === null) { await api.sendMessage(chatId, "Reply 1 or 2."); return; }
  if (idx === 0) {
    state.splitChoice = "single";
    return moveToConfirm(api, state, chatId);
  }
  state.splitChoice = "distributed";
  state.step = "distCount";
  await api.sendMessage(chatId, "How many top placements share this prize? (e.g. 5)");
}

async function handleDistCount(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  if (!/^\d+$/.test(input)) { await api.sendMessage(chatId, "Send a positive integer."); return; }
  const n = Number(input);
  if (n <= 0 || n > 1000) { await api.sendMessage(chatId, "Must be 1–1000."); return; }
  state.distCount = n;
  state.step = "distType";
  await api.sendMessage(chatId, [
    "Distribution shape:",
    "  1. Linear (1st gets a bit more, decreases steadily)",
    "  2. Exponential (1st gets way more, drops off fast)",
    "  3. Uniform (equal split across all paid placements)",
    "",
    "Reply with a number.",
  ].join("\n"));
}

async function handleDistType(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  const idx = parsePickIndex(input, 3);
  if (idx === null) { await api.sendMessage(chatId, "Reply 1, 2, or 3."); return; }
  state.distType = idx === 0 ? "linear" : idx === 1 ? "exponential" : "uniform";
  if (state.distType === "uniform") {
    return moveToConfirm(api, state, chatId);
  }
  state.distWeight = 1;
  state.step = "distWeight";
  await renderDistributionCurve(api, state, chatId);
}

async function renderDistributionCurve(api: TelegramApi, state: State, chatId: string): Promise<void> {
  const distType = state.distType!;
  const count = state.distCount!;
  const weight = state.distWeight ?? 1;
  const percentages = calculateDistributionPercentages(count, weight, distType);
  const TOP = 10;
  const lines: string[] = [
    `Distribution: ${distType}, weight ${weight}, ${count} places.`,
    "Pool share per placement:",
  ];
  if (percentages.length <= TOP) {
    percentages.forEach((p, i) => lines.push(`  ${i + 1}. ${p.toFixed(2)}%`));
  } else {
    for (let i = 0; i < TOP - 1; i++) lines.push(`  ${i + 1}. ${percentages[i]!.toFixed(2)}%`);
    lines.push("  …");
    lines.push(`  ${percentages.length}. ${percentages[percentages.length - 1]!.toFixed(2)}%`);
  }
  lines.push("");
  lines.push("Reply 'ok' to keep, or send a new weight (e.g. '2', '0.5') to recalculate.");
  await api.sendMessage(chatId, lines.join("\n"));
}

async function handleDistWeight(api: TelegramApi, state: State, chatId: string, input: string): Promise<void> {
  if (/^ok$/i.test(input.trim())) {
    return moveToConfirm(api, state, chatId);
  }
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
  state.distWeight = w;
  await renderDistributionCurve(api, state, chatId);
}

async function moveToConfirm(api: TelegramApi, state: State, chatId: string): Promise<void> {
  state.step = "confirm";
  const token = state.token!;
  const amountFmt = formatTokenAmount(state.amountRaw!, token.decimals);
  const lines = [
    "Ready to sponsor:",
    `  Tournament: ${state.tournamentId} — ${state.tournamentName}`,
    `  Prize: ${amountFmt} ${token.symbol}`,
  ];
  if (state.splitChoice === "single") {
    lines.push(`  Awarded: winner takes all`);
  } else {
    const distSuffix = state.distType === "uniform" ? "" : `, weight ${state.distWeight ?? 1}`;
    lines.push(`  Awarded: top ${state.distCount} via ${state.distType}${distSuffix}`);
  }
  lines.push("");
  lines.push(
    "Tap 'Confirm in Cartridge' below to sign approve + add_prize in your browser.",
    "Reply 'submit' to send the Mini App button, or /cancel.",
  );
  await api.sendMessage(chatId, lines.join("\n"));
}

async function handleConfirm(
  api: TelegramApi,
  config: Config,
  handshakes: HandshakeStore,
  state: State,
  chatId: string,
  input: string,
): Promise<void> {
  if (!/^submit$/i.test(input.trim())) {
    await api.sendMessage(chatId, "Reply 'submit' to confirm in Cartridge, or /cancel.");
    return;
  }
  const budokanAddress = config.budokanAddress ?? CHAINS[state.chain]?.budokanAddress;
  if (!budokanAddress) {
    await api.sendMessage(chatId, `Internal error: no Budokan address for ${state.chain}.`);
    return;
  }

  const token = state.token!;
  const distribution: DistributionSpec | undefined =
    state.splitChoice === "distributed"
      ? state.distType === "uniform"
        ? { kind: "uniform" }
        : { kind: state.distType!, weight: state.distWeight ?? 1 }
      : undefined;

  const addPrizeArgs: AddPrizeArgs = {
    tournamentId: state.tournamentId!,
    tokenAddress: token.tokenAddress,
    amount: state.amountRaw!,
    distribution,
    distributionCount: state.distCount,
    sponsorAddress: state.sponsorAddress!,
  };
  const calls: Call[] = [
    buildErc20ApproveCall(token.tokenAddress, budokanAddress, state.amountRaw!),
    buildAddPrizeCall(budokanAddress, addPrizeArgs),
  ];

  const amountFmt = formatTokenAmount(state.amountRaw!, token.decimals);
  const summary = [
    `Sponsor prize for tournament ${state.tournamentId}`,
    `  Prize: ${amountFmt} ${token.symbol}`,
    `  Awarded: ${state.splitChoice === "single" ? "winner takes all" : `top ${state.distCount} via ${state.distType}`}`,
    "",
    `Calls (${calls.length}):`,
    `  1. approve(${shortAddr(budokanAddress)}, ${state.amountRaw}) on token ${shortAddr(token.tokenAddress)}`,
    `  2. add_prize(${state.tournamentId}, …)`,
  ].join("\n");

  states.delete(chatId);

  const handshake = handshakes.mint(chatId, "tx", state.chain, { payload: { calls, summary } });
  const url = `${config.miniAppUrl}/?token=${encodeURIComponent(handshake.token)}&mode=tx`;
  await api.sendMessage(
    chatId,
    [
      "Tap below — the Mini App will open and Cartridge will ask you to confirm both calls.",
      "",
      summary,
    ].join("\n"),
    { replyMarkup: webAppButton("Confirm in Cartridge", url) },
  );
}

function sdkClient(config: Config, chain: Chain) {
  return createBudokanClient({
    chain,
    ...(config.apiUrl ? { apiBaseUrl: config.apiUrl } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.budokanAddress ? { budokanAddress: config.budokanAddress } : {}),
    ...(config.viewerAddress ? { viewerAddress: config.viewerAddress } : {}),
  } as Parameters<typeof createBudokanClient>[0]);
}

async function buildGameNameMap(chain: Chain): Promise<Map<string, string>> {
  const games = await gamesForChain(chain);
  const map = new Map<string, string>();
  for (const g of games) map.set(g.contractAddress.toLowerCase(), g.name);
  return map;
}

// --- helpers (duplicated from create.ts; would consolidate if a third
// command needs them) ---

function parsePickIndex(input: string, n: number): number | null {
  if (!/^\d+$/.test(input)) return null;
  const v = Number(input);
  if (!Number.isInteger(v) || v < 1 || v > n) return null;
  return v - 1;
}

function parseTokenAmount(input: string, decimals: number): string | null {
  const t = input.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  const padded = frac.padEnd(decimals, "0");
  const combined = (whole === "" ? "0" : whole) + padded;
  return combined.replace(/^0+/, "") || "0";
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
      raw.push(1 + (positions - i - 1) * (weight / 10));
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

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
