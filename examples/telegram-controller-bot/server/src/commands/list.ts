// Read-only listing commands. Stateless — pagination is explicit via args,
// not a multi-turn "next/prev" loop, so the user can deep-link to a page
// (`/tournaments live 3`) and share command output across chats.
//
//   /tournaments [phase] [page]   List tournaments on the active chain
//   /my_tournaments [page]        List tournaments the connected user is in

import { createBudokanClient, type Tournament } from "@provable-games/budokan-sdk";
import { createDenshokanClient } from "@provable-games/denshokan-sdk";

import type { Config } from "../config.ts";
import type { Chain, ChatStateStore } from "../chat-state.ts";
import type { SessionStore } from "../session-store.ts";
import { gamesForChain } from "../catalog/games.ts";
import { TelegramApi } from "../telegram-api.ts";
import { formatError } from "../format-error.ts";
import { tournamentPageUrl } from "@provable-games/budokan-sdk";
import { formatTimeUntil, formatTopPrizes } from "../format.ts";

const PAGE_SIZE = 5;

const ALL_PHASES = ["scheduled", "registration", "staging", "live", "submission", "finalized"] as const;
type Phase = typeof ALL_PHASES[number];

function isPhase(value: string): value is Phase {
  return (ALL_PHASES as readonly string[]).includes(value);
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

/**
 * /tournaments [phase] [page] — list tournaments on the active chain.
 * Args order is flexible: either or both of phase / page are optional, and
 * if only one numeric arg is given it's treated as the page.
 */
export async function tournaments(
  api: TelegramApi,
  config: Config,
  chatStates: ChatStateStore,
  chatId: string,
  args: string[],
): Promise<void> {
  const chain = await chatStates.getChain(chatId);
  const { phase, page } = parseListArgs(args);
  if (phase === "invalid") {
    await api.sendMessage(
      chatId,
      `Usage: /tournaments [phase] [page]\nPhases: ${ALL_PHASES.join(", ")}`,
    );
    return;
  }
  const offset = (page - 1) * PAGE_SIZE;

  let result;
  try {
    result = await sdkClient(config, chain).getTournaments({
      ...(phase ? { phase } : {}),
      limit: PAGE_SIZE,
      offset,
      sort: "created_at",
      // Populate prizeAggregation per tournament so we can show the top
      // tokens inline without N+1 fetches.
      includePrizeSummary: true,
    });
  } catch (error) {
    await api.sendMessage(chatId, `Lookup failed: ${formatError(error)}`);
    return;
  }

  if (result.data.length === 0) {
    const hint = page > 1 ? "  (try a lower page)" : "";
    await api.sendMessage(
      chatId,
      phase
        ? `🎯 No ${phase} tournaments on ${chain}.${hint}`
        : `🎯 No tournaments on ${chain}.${hint}`,
    );
    return;
  }

  const gameNames = await buildGameNameMap(chain);
  const total = result.total ?? result.data.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const header = [
    `🏟️ Tournaments on ${chain}`,
    phase ? `· ${phase}` : "",
    `· page ${page}/${totalPages} · ${total} total`,
  ].filter(Boolean).join(" ");

  const lines = [header, "", ...result.data.flatMap((t) => formatTournamentBlock(t, gameNames, chain))];

  if (totalPages > 1) {
    const args = [phase, page + 1].filter(Boolean).join(" ");
    if (page < totalPages) lines.push("", `Reply '/tournaments ${args}' for the next page.`);
  }

  await api.sendMessage(chatId, lines.join("\n"));
}

/**
 * /my_tournaments [page] — list tournaments the connected user has entered.
 * Requires an active session on the chat's current chain (to know the
 * sponsor address).
 */
export async function myTournaments(
  api: TelegramApi,
  config: Config,
  chatStates: ChatStateStore,
  sessions: SessionStore,
  chatId: string,
  args: string[],
): Promise<void> {
  const chain = await chatStates.getChain(chatId);
  const session = await sessions.get(chatId, chain);
  if (!session) {
    await api.sendMessage(
      chatId,
      `Not connected on ${chain}. Run /connect first so I know whose tournaments to show.`,
    );
    return;
  }

  let page = 1;
  if (args.length > 0 && args[0]) {
    if (!/^\d+$/.test(args[0])) {
      await api.sendMessage(chatId, "Usage: /my_tournaments [page]");
      return;
    }
    page = Number(args[0]);
    if (page < 1) page = 1;
  }
  const offset = (page - 1) * PAGE_SIZE;

  // budokan v0.1.23 has no getPlayerTournaments; the canonical pattern is
  // denshokan → owned tokens → extract contextId (tournament id) → budokan
  // getTournaments({ tournamentIds }). Notes in TournamentListParams.tournamentIds
  // call this out explicitly.
  let tournamentIds: string[];
  try {
    tournamentIds = await fetchOwnedTournamentIds(chain, session.session.address);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't read your tokens: ${formatError(error)}`);
    return;
  }
  if (tournamentIds.length === 0) {
    await api.sendMessage(
      chatId,
      `🎯 No tournaments for ${session.session.username} on ${chain}.\nRun /enter to join one.`,
    );
    return;
  }

  // Hand budokan ALL the IDs at once. The indexer filters out IDs that
  // don't resolve to real tournaments (e.g. stale contextIds from tokens
  // whose tournaments were removed), so we get back only the ones that
  // exist. Paginating raw IDs before asking would cause pages to under-
  // fill in proportion to the unresolved count, which looked like a bug.
  let result;
  try {
    result = await sdkClient(config, chain).getTournaments({
      tournamentIds,
      limit: tournamentIds.length, // ask for all matches up front
      offset: 0,
      sort: "created_at",
      includePrizeSummary: true,
    });
  } catch (error) {
    await api.sendMessage(chatId, `Lookup failed: ${formatError(error)}`);
    return;
  }

  const resolved = result.data;
  const total = resolved.length;
  if (total === 0) {
    await api.sendMessage(
      chatId,
      `🎯 No tournaments for ${session.session.username} on ${chain}.\n(You have ${tournamentIds.length} game tokens but none of their tournaments are indexed.)`,
    );
    return;
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) {
    await api.sendMessage(chatId, `No tournaments at page ${page}. Last page is ${totalPages}.`);
    return;
  }
  const pageData = resolved.slice(offset, offset + PAGE_SIZE);

  const gameNames = await buildGameNameMap(chain);
  const lines = [
    `🏟️ Your tournaments — ${session.session.username} on ${chain} · page ${page}/${totalPages} · ${total} total`,
    "",
    ...pageData.flatMap((t) => formatTournamentBlock(t, gameNames, chain)),
  ];
  if (totalPages > 1 && page < totalPages) {
    lines.push("", `Reply '/my_tournaments ${page + 1}' for the next page.`);
  }

  await api.sendMessage(chatId, lines.join("\n"));
}

/**
 * Tournament IDs the user has entered, derived from denshokan-tracked
 * game tokens whose `contextId` is set. Returns unique IDs, ordered by
 * most-recently-minted first (denshokan default sort).
 *
 * Caps at 200 tokens — anyone with more than that is unlikely to be
 * paging through `/my_tournaments` in chat anyway.
 */
async function fetchOwnedTournamentIds(chain: Chain, address: string): Promise<string[]> {
  const denshokan = createDenshokanClient({ chain });
  const res = await denshokan.getPlayerTokens(address, { limit: 200 });
  const ids = new Set<string>();
  for (const token of res.data) {
    if (token.hasContext && token.contextId !== null) {
      ids.add(String(token.contextId));
    }
  }
  return Array.from(ids);
}

/**
 * Multi-line block summary used by both listings. Shows game, entry
 * count, time-to-end (when known), the top 3 sponsored prizes, and a
 * direct link. Returns an array of lines plus a blank line separator so
 * callers can flatMap them straight into the output.
 */
function formatTournamentBlock(
  t: Tournament,
  gameNames: Map<string, string>,
  chain: Chain,
): string[] {
  const gameLabel = gameNames.get(t.gameAddress.toLowerCase()) ?? shortHex(t.gameAddress);
  const entries = `👥 ${t.entryCount} ${t.entryCount === 1 ? "entry" : "entries"}`;
  // Prefer gameEndTime — when the tournament's competitive window
  // closes. Tournaments past that point are in their submission window
  // or finalized; the relative formatter handles past timestamps.
  const ends = formatTimeUntil(t.gameEndTime);
  const meta = [entries, ends].filter(Boolean).join(" · ");
  const prizes = formatTopPrizes(t, chain);

  const lines = [
    `🎯 #${t.id} ${t.name || "(unnamed)"} — 🎮 ${gameLabel}`,
    `   ${meta}`,
  ];
  if (prizes) {
    lines.push(`   🏆 ${prizes}`);
  }
  lines.push(`   ${tournamentPageUrl(chain, t.id)}`);
  lines.push("");
  return lines;
}

/**
 * One-shot map of contractAddress → game name for the chain. Avoids N
 * denshokan lookups when rendering a page of tournaments. Reuses
 * gamesForChain (which already intersects denshokan registry ∩ whitelist).
 */
async function buildGameNameMap(chain: Chain): Promise<Map<string, string>> {
  const games = await gamesForChain(chain);
  const map = new Map<string, string>();
  for (const g of games) {
    map.set(g.contractAddress.toLowerCase(), g.name);
  }
  return map;
}

function parseListArgs(args: string[]): { phase?: Phase; page: number } | { phase: "invalid"; page: number } {
  let phase: Phase | undefined;
  let page = 1;
  for (const arg of args) {
    if (!arg) continue;
    if (/^\d+$/.test(arg)) {
      const n = Number(arg);
      if (n >= 1) page = n;
    } else {
      const lower = arg.toLowerCase();
      if (!isPhase(lower)) return { phase: "invalid", page };
      phase = lower;
    }
  }
  return { phase, page };
}

function shortHex(value: string): string {
  if (!value || value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

