// /leaderboard <tournamentId> [page]
//
// Read-only ranking of the tokens entered into a tournament, sorted in the
// direction the tournament's leaderboard config implies (descending for
// points-style, ascending for golf-style).
//
// Data source is denshokan-sdk's getTokens filtered by contextId — that
// gives us the richer Token shape (score, playerName, owner, gameOver)
// rather than the bare {position, tokenId} the on-chain viewer returns.
// We sort by score with the appropriate direction; players that haven't
// played yet (score === 0 with gameOver false) are filtered out so the
// leaderboard reads as "who's actually competing" not "who's signed up".
//
// Stateless: pagination is in args (`/leaderboard 6 2`), no in-memory
// state to lose to a Railway redeploy.
//
// To keep the command surface small we don't offer a tournament picker
// here — the user already has /tournaments and /my_tournaments for
// finding ids. If that becomes a friction point we can lift the picker
// pattern from /enter.

import { createBudokanClient } from "@provable-games/budokan-sdk";
import { createDenshokanClient, type Token } from "@provable-games/denshokan-sdk";

import type { Config } from "../config.ts";
import type { Chain, ChatStateStore } from "../chat-state.ts";
import { TelegramApi } from "../telegram-api.ts";
import { formatError } from "../format-error.ts";
import { tournamentPageUrl } from "../links.ts";

const PAGE_SIZE = 10;

export async function leaderboard(
  api: TelegramApi,
  config: Config,
  chatStates: ChatStateStore,
  chatId: string,
  args: string[],
): Promise<void> {
  if (args.length === 0 || !args[0] || !/^\d+$/.test(args[0])) {
    await api.sendMessage(
      chatId,
      "Usage: /leaderboard <tournamentId> [page]\nFind ids via /tournaments.",
    );
    return;
  }
  const tournamentId = args[0];
  let page = 1;
  if (args.length > 1 && args[1]) {
    if (!/^\d+$/.test(args[1])) {
      await api.sendMessage(chatId, "Page must be a positive integer.");
      return;
    }
    page = Number(args[1]);
    if (page < 1) page = 1;
  }
  const chain = await chatStates.getChain(chatId);

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
 *
 * Position medals 🥇🥈🥉 are emoji-free intentionally — keep with the
 * rest of the bot's tone (no emojis unless asked).
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

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}
