import type { PlayerStats, PlayerTournament, PlayerTournamentParams } from "../types/player.js";
import type { PaginatedResult } from "../types/common.js";
import { apiFetch, buildQueryString, extractPagination } from "./base.js";
import type { ApiFetchOptions } from "./base.js";
import { snakeToCamel } from "../utils/mappers.js";
import { normalizeAddress } from "../utils/address.js";

interface ApiContext {
  retryAttempts?: number;
  retryDelay?: number;
  timeout?: number;
}

function fetchOpts(ctx?: ApiContext): Partial<ApiFetchOptions> {
  return {
    retryAttempts: ctx?.retryAttempts,
    retryDelay: ctx?.retryDelay,
    timeout: ctx?.timeout,
  };
}

/**
 * Fetch tournaments for a player.
 */
export async function getPlayerTournaments(
  baseUrl: string,
  address: string,
  params?: PlayerTournamentParams,
  ctx?: ApiContext,
): Promise<PaginatedResult<PlayerTournament>> {
  const normalized = normalizeAddress(address);
  const qs = buildQueryString({
    limit: params?.limit,
    offset: params?.offset,
    phase: params?.phase,
    game_token_ids: params?.gameTokenIds?.join(","),
  });
  const result = await apiFetch<Record<string, unknown>>(`${baseUrl}/players/${normalized}/tournaments${qs}`, fetchOpts(ctx));
  const { total, limit: resLimit, offset: resOffset } = extractPagination(result, { limit: params?.limit, offset: params?.offset });
  return {
    data: (result.data as Record<string, unknown>[]).map((item) => snakeToCamel<PlayerTournament>(item)),
    total,
    limit: resLimit,
    offset: resOffset,
  };
}

/**
 * Fetch stats for a player.
 */
export async function getPlayerStats(
  baseUrl: string,
  address: string,
  ctx?: ApiContext,
): Promise<PlayerStats> {
  const normalized = normalizeAddress(address);
  const result = await apiFetch<{ data: Record<string, unknown> }>(
    `${baseUrl}/players/${normalized}/stats`,
    fetchOpts(ctx),
  );
  return snakeToCamel<PlayerStats>(result.data);
}
