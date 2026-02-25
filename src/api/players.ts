import type { PlayerStats, PlayerTournament } from "../types/player.js";
import type { PaginatedResult } from "../types/common.js";
import { apiFetch, buildQueryString } from "./base.js";
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
  params?: { limit?: number; offset?: number },
  ctx?: ApiContext,
): Promise<PaginatedResult<PlayerTournament>> {
  const normalized = normalizeAddress(address);
  const qs = buildQueryString({
    limit: params?.limit,
    offset: params?.offset,
  });
  const result = await apiFetch<{
    data: Record<string, unknown>[];
    total?: number;
    limit: number;
    offset: number;
  }>(`${baseUrl}/players/${normalized}/tournaments${qs}`, fetchOpts(ctx));
  return {
    data: result.data.map((item) => snakeToCamel<PlayerTournament>(item)),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
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
