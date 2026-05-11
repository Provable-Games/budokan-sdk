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
  createBudokanClient,
  type Tournament,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient, type Token } from "@provable-games/denshokan-sdk";

import type { Config } from "../config.ts";
import type { Chain, ChatStateStore } from "../chat-state.ts";
import { TelegramApi } from "../telegram-api.ts";
import { gamesForChain } from "../catalog/games.ts";
import { formatError } from "../format-error.ts";
import { tournamentPageUrl } from "../links.ts";

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
    });
    tournaments = res.data;
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch tournaments: ${formatError(error)}`);
    return;
  }
  if (tournaments.length === 0) {
    await api.sendMessage(chatId, `No tournaments on ${chain} yet.`);
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

  const lines = [
    `Pick a tournament to show the leaderboard for on ${chain}:`,
    "",
    ...snapshot.map((t, i) => {
      const game = gameNames.get(t.gameAddress.toLowerCase()) ?? shortAddr(t.gameAddress);
      const entries = `${t.entryCount} ${t.entryCount === 1 ? "entry" : "entries"}`;
      return `  ${i + 1}. #${t.id} ${t.name} — ${game} · ${entries}`;
    }),
    "",
    "Reply with a number, or send '/leaderboard <id>' to look up a specific one. /cancel to abort.",
  ];
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
  let tournament;
  try {
    tournament = await sdkClient(config, chain).getTournament(tournamentId);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch tournament: ${formatError(error)}`);
    return;
  }
  if (!tournament) {
    await api.sendMessage(chatId, `Tournament ${tournamentId} not found on ${chain}.`);
    return;
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
  const denshokan = createDenshokanClient({ chain });
  let tokens: Token[];
  try {
    const res = await denshokan.getTokens({
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

  const lines = [
    `Leaderboard — Tournament #${tournamentId}${tournament.name ? ` (${tournament.name})` : ""} on ${chain}`,
    `Sort: ${ascending ? "lower scores win" : "higher scores win"}`,
    "",
    ...slice.map((t, i) => formatRow(rankFor(i), t)),
  ];
  if (totalPages > 1) {
    lines.push("", `Page ${page}/${totalPages} · ${total} competitors`);
    if (page < totalPages) {
      lines.push(`Reply '/leaderboard ${tournamentId} ${page + 1}' for the next page.`);
    }
  } else {
    lines.push("", `${total} ${total === 1 ? "competitor" : "competitors"}`);
  }
  lines.push("", `View on budokan.gg: ${tournamentPageUrl(chain, tournamentId)}`);

  await api.sendMessage(chatId, lines.join("\n"));
}

/**
 * One row of the leaderboard. Prefers playerName (set when the user
 * minted the game token) and falls back to a short owner address so
 * anonymous entries still show distinguishable identities.
 */
function formatRow(rank: number, t: Token): string {
  const name = t.playerName?.trim() || `(anon ${shortAddr(t.owner)})`;
  const finished = t.gameOver ? " ✓" : "";
  return `  ${rank}. ${t.score} · ${name} (token #${t.tokenId})${finished}`;
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
