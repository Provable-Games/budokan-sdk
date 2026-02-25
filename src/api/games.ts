import type { Tournament, TournamentListParams } from "../types/tournament.js";
import type { PlatformStats } from "../types/activity.js";
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
 * Fetch tournaments for a specific game.
 */
export async function getGameTournaments(
  baseUrl: string,
  gameAddress: string,
  params?: Omit<TournamentListParams, "gameAddress">,
  ctx?: ApiContext,
): Promise<PaginatedResult<Tournament>> {
  const normalized = normalizeAddress(gameAddress);
  const qs = buildQueryString({
    creator: params?.creator,
    phase: params?.phase,
    limit: params?.limit,
    offset: params?.offset,
  });
  const result = await apiFetch<{
    data: Record<string, unknown>[];
    total?: number;
    limit: number;
    offset: number;
  }>(`${baseUrl}/games/${normalized}/tournaments${qs}`, fetchOpts(ctx));
  return {
    data: result.data.map((item) => snakeToCamel<Tournament>(item)),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  };
}

/**
 * Fetch tournament stats for a specific game.
 */
export async function getGameStats(
  baseUrl: string,
  gameAddress: string,
  ctx?: ApiContext,
): Promise<PlatformStats> {
  const normalized = normalizeAddress(gameAddress);
  const result = await apiFetch<{ data: Record<string, unknown> }>(
    `${baseUrl}/games/${normalized}/stats`,
    fetchOpts(ctx),
  );
  return snakeToCamel<PlatformStats>(result.data);
}
