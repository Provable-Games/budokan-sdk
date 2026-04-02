import type { Tournament, TournamentListParams } from "../types/tournament.js";
import type { PlatformStats } from "../types/activity.js";
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
  const result = await apiFetch<Record<string, unknown>>(`${baseUrl}/games/${normalized}/tournaments${qs}`, fetchOpts(ctx));
  const { total, limit: resLimit, offset: resOffset } = extractPagination(result, { limit: params?.limit, offset: params?.offset });
  return {
    data: (result.data as Record<string, unknown>[]).map((item) => snakeToCamel<Tournament>(item)),
    total,
    limit: resLimit,
    offset: resOffset,
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
