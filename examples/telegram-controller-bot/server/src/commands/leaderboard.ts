// /leaderboard [tournamentId] [page]
//
// Read-only ranking of the tokens entered into a tournament, sorted in the
// direction the tournament's leaderboard config implies (descending for
// points-style, ascending for golf-style).
//
// Two entry points:
//   - With an id: render directly (stateless; pagination via args).
//   - Without an id: show a numbered picker of recent tournaments, let
//     the user pick one, then render the leaderboard for that id.
//
// Data source is denshokan-sdk's getTokens filtered by contextId — that
// gives us the richer Token shape (score, playerName, owner, gameOver)
// rather than the bare {position, tokenId} the on-chain viewer returns.
// We sort by score with the appropriate direction; players that haven't
// played yet (score === 0 with gameOver false) are filtered out so the
// leaderboard reads as "who's actually competing" not "who's signed up".
//
// Picker state is in-memory and short-lived — survives a turn, doesn't
// survive a redeploy. The dispatcher's generic "no pending flow"
// fallback covers the post-restart case.

import {
  CHAINS,
  createBudokanClient,
  normalizeAddress,
  type Tournament,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient, type Token } from "@provable-games/denshokan-sdk";

import type { Config } from "../config.ts";
import type { Chain, ChatStateStore } from "../chat-state.ts";
import { TelegramApi } from "../telegram-api.ts";
import { gamesForChain } from "../catalog/games.ts";
import { formatError } from "../format-error.ts";
import { tournamentPageUrl } from "@provable-games/budokan-sdk";
import { formatTimeUntil, formatTopPrizes, rankMedal } from "../format.ts";

const PAGE_SIZE = 10;
// Picker fetches a window of the most-recently-created tournaments
// across all phases. Anyone wanting older boards can pass the id
// directly. 25 keeps the picker readable in a single Telegram message.
const PICKER_LIMIT = 25;

interface PickerState {
  chain: Chain;
  tournaments: Array<{
    id: string;
    name: string;
    gameAddress: string;
    entryCount: number;
  }>;
  gameNames: Map<string, string>;
}

const pickerStates = new Map<string, PickerState>();

export function isPending(chatId: string): boolean {
  return pickerStates.has(chatId);
}

export function cancel(chatId: string): boolean {
  return pickerStates.delete(chatId);
}

/**
 * Main entry point. Routes to direct render when an id is supplied or
 * to a picker when not.
 */
export async function leaderboard(
  api: TelegramApi,
  config: Config,
  chatStates: ChatStateStore,
  chatId: string,
  args: string[],
): Promise<void> {
  const chain = await chatStates.getChain(chatId);

  // Direct path: /leaderboard <id> [page]
  if (args.length >= 1 && args[0] && /^\d+$/.test(args[0])) {
    const tournamentId = args[0];
    let page = 1;
    if (args.length > 1 && args[1]) {
      if (!/^\d+$/.test(args[1])) {
        await api.sendMessage(chatId, "Page must be a positive integer.");
        return;
      }
      page = Math.max(1, Number(args[1]));
    }
    return renderLeaderboard(api, config, chain, chatId, tournamentId, page);
  }
  if (args.length !== 0) {
    await api.sendMessage(
      chatId,
      "Usage: /leaderboard [tournamentId] [page]\nWith no id I'll show a picker.",
    );
    return;
  }

  // Picker path: list recent tournaments. We deliberately don't filter
  // by phase or entry count — users sometimes want to peek at finalized
  // boards or check why an active tournament has no scores yet.
  let tournaments: Tournament[];
  try {
    const res = await sdkClient(config, chain).getTournaments({
      limit: PICKER_LIMIT,
      sort: "created_at",
      // Same as /tournaments — surface top prizes per row.
      includePrizeSummary: true,
    });
    tournaments = res.data;
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch tournaments: ${formatError(error)}`);
    return;
  }
  if (tournaments.length === 0) {
    await api.sendMessage(chatId, `🎯 No tournaments on ${chain} yet.`);
    return;
  }
  const gameNames = await buildGameNameMap(chain);
  const snapshot: PickerState["tournaments"] = tournaments.map((t) => ({
    id: t.id,
    name: t.name || "(unnamed)",
    gameAddress: t.gameAddress,
    entryCount: t.entryCount,
  }));
  pickerStates.set(chatId, { chain, tournaments: snapshot, gameNames });

  const lines: string[] = [
    `📊 Pick a tournament to show the leaderboard for on ${chain}:`,
    "",
  ];
  tournaments.forEach((t, i) => {
    const game = gameNames.get(t.gameAddress.toLowerCase()) ?? shortAddr(t.gameAddress);
    const entries = `👥 ${t.entryCount} ${t.entryCount === 1 ? "entry" : "entries"}`;
    const ends = formatTimeUntil(t.gameEndTime);
    const meta = [entries, ends].filter(Boolean).join(" · ");
    lines.push(`  ${i + 1}. 🎯 #${t.id} ${t.name || "(unnamed)"} — 🎮 ${game}`);
    lines.push(`     ${meta}`);
    const prizes = formatTopPrizes(t, chain);
    if (prizes) lines.push(`     🏆 ${prizes}`);
  });
  lines.push("");
  lines.push("Reply with a number, or send '/leaderboard <id>' to look up a specific one. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

/**
 * Picker reply handler. Called by the dispatcher when a plain text
 * message arrives and pickerStates has an entry for the chat.
 */
export async function handleAnswer(
  api: TelegramApi,
  config: Config,
  chatStates: ChatStateStore,
  chatId: string,
  text: string,
): Promise<void> {
  const state = pickerStates.get(chatId);
  if (!state) return;

  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    await api.sendMessage(
      chatId,
      `Reply with a number 1–${state.tournaments.length}, or /cancel.`,
    );
    return;
  }
  const n = Number(trimmed);
  if (n < 1 || n > state.tournaments.length) {
    await api.sendMessage(
      chatId,
      `Out of range. Pick 1–${state.tournaments.length}, or /cancel.`,
    );
    return;
  }
  const chosen = state.tournaments[n - 1]!;
  pickerStates.delete(chatId);
  // Use chatStates rather than the snapshotted chain on the off-chance
  // the user switched chains between picker render and pick — render
  // for the chain that was active when they picked.
  const chain = await chatStates.getChain(chatId);
  await renderLeaderboard(api, config, chain, chatId, chosen.id, 1);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function renderLeaderboard(
  api: TelegramApi,
  config: Config,
  chain: Chain,
  chatId: string,
  tournamentId: string,
  page: number,
): Promise<void> {
  // Look up the tournament for its name and leaderboard direction.
  // Prize aggregation comes from a sibling endpoint — getTournament
  // itself doesn't accept includePrizeSummary, so we merge in the
  // aggregation result ourselves before formatting.
  const sdk = sdkClient(config, chain);
  let tournament;
  try {
    tournament = await sdk.getTournament(tournamentId);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch tournament: ${formatError(error)}`);
    return;
  }
  if (!tournament) {
    await api.sendMessage(chatId, `Tournament ${tournamentId} not found on ${chain}.`);
    return;
  }
  // Best-effort prize aggregation — failure shouldn't break the
  // leaderboard render, just the prize line.
  try {
    tournament.prizeAggregation = await sdk.getTournamentPrizeAggregation(tournamentId);
  } catch {
    tournament.prizeAggregation = undefined;
  }
  // Default to descending (points-style). leaderboardConfig is the
  // structured source; fall back to the flat summary the indexer also
  // populates so we behave sensibly when one or the other is missing
  // (just-created tournaments often lag on one side).
  const ascending =
    tournament.leaderboardConfig?.ascending ?? tournament.leaderboardAscending ?? false;

  // Pull a wide window: we want totals to compute pagination, and the
  // post-filter for score===0 means we might skip a few rows. Cap at 500
  // — plenty for chat-shaped paging.
  //
  // The right scope is (minterAddress, contextId). denshokan's contextId
  // namespace is per-minter, so asking for contextId=6 alone returns
  // tokens from any minter that uses context 6 — including unrelated
  // tournaments on other platforms. Budokan is the minter for tournament
  // entries, so pinning minterAddress to the budokan contract narrows to
  // this tournament's actual entrants regardless of which game it uses.
  const budokanAddress = config.budokanAddress ?? CHAINS[chain]?.budokanAddress;
  if (!budokanAddress) {
    await api.sendMessage(chatId, `Internal error: no Budokan address for ${chain}.`);
    return;
  }
  const denshokan = createDenshokanClient({ chain });
  let tokens: Token[];
  try {
    const res = await denshokan.getTokens({
      minterAddress: normalizeAddress(budokanAddress),
      contextId: Number(tournamentId),
      sort: { field: "score", direction: ascending ? "asc" : "desc" },
      limit: 500,
    });
    tokens = res.data;
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch leaderboard: ${formatError(error)}`);
    return;
  }

  // Players who haven't played get score=0. Including them at the top of
  // an ascending leaderboard is misleading; at the bottom of a
  // descending one it just pads the list. Drop them either way — the
  // leaderboard is for competitors, not entrants.
  const competitors = tokens.filter((t) => t.score > 0 || t.gameOver);

  const total = competitors.length;
  if (total === 0) {
    await api.sendMessage(
      chatId,
      [
        `Leaderboard — Tournament #${tournamentId}${tournament.name ? ` (${tournament.name})` : ""} on ${chain}`,
        "",
        "No scores yet. Players have entered but nobody has played.",
        "",
        `View on budokan.gg: ${tournamentPageUrl(chain, tournamentId)}`,
      ].join("\n"),
    );
    return;
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) {
    await api.sendMessage(
      chatId,
      `Page ${page} is past the end. Last page is ${totalPages}.`,
    );
    return;
  }

  const start = (page - 1) * PAGE_SIZE;
  const slice = competitors.slice(start, start + PAGE_SIZE);
  const rankFor = (i: number) => start + i + 1;

  const header = `📊 Leaderboard — 🎯 #${tournamentId}${tournament.name ? ` (${tournament.name})` : ""} on ${chain}`;
  const sortLine = ascending ? "🔻 Lower scores win" : "🔺 Higher scores win";
  const ends = formatTimeUntil(tournament.gameEndTime);
  const prizes = formatTopPrizes(tournament, chain);

  const lines: string[] = [header];
  const meta = [sortLine, ends].filter(Boolean).join(" · ");
  if (meta) lines.push(meta);
  if (prizes) lines.push(`🏆 ${prizes}`);
  lines.push("");
  slice.forEach((t, i) => lines.push(formatRow(rankFor(i), t)));

  if (totalPages > 1) {
    lines.push("", `📄 Page ${page}/${totalPages} · 👥 ${total} competitors`);
    if (page < totalPages) {
      lines.push(`Reply '/leaderboard ${tournamentId} ${page + 1}' for the next page.`);
    }
  } else {
    lines.push("", `👥 ${total} ${total === 1 ? "competitor" : "competitors"}`);
  }
  lines.push("", `🔗 ${tournamentPageUrl(chain, tournamentId)}`);

  await api.sendMessage(chatId, lines.join("\n"));
}

/**
 * One row of the leaderboard. Prefers playerName (set when the user
 * minted the game token) and falls back to a short owner address so
 * anonymous entries still show distinguishable identities.
 */
function formatRow(rank: number, t: Token): string {
  const name = t.playerName?.trim() || `(anon ${shortAddr(t.owner)})`;
  const finished = t.gameOver ? " ✅" : "";
  const medal = rankMedal(rank);
  // Medal takes the rank's place for top 3; for the rest fall back to
  // a numeric prefix. Token IDs on this chain are packed felts ~66
  // chars long — show a short head/tail so rows fit on one line.
  const prefix = medal ? `${medal} ` : `${rank}. `;
  return `  ${prefix}${t.score} · ${name} (${shortTokenId(t.tokenId)})${finished}`;
}

function shortTokenId(tokenId: string): string {
  if (!tokenId || tokenId.length <= 14) return `token #${tokenId}`;
  return `token #${tokenId.slice(0, 8)}…${tokenId.slice(-4)}`;
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

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}
