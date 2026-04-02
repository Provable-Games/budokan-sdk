import type { ActivityEvent, ActivityParams, PlatformStats, PrizeStats } from "../types/activity.js";
import type { PaginatedResult } from "../types/common.js";
import { apiFetch, buildQueryString, extractPagination } from "./base.js";
import type { ApiFetchOptions } from "./base.js";
import { snakeToCamel } from "../utils/mappers.js";

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
 * Fetch activity events with optional filtering.
 */
export async function getActivity(
  baseUrl: string,
  params?: ActivityParams,
  ctx?: ApiContext,
): Promise<PaginatedResult<ActivityEvent>> {
  const qs = buildQueryString({
    event_type: params?.eventType,
    tournament_id: params?.tournamentId,
    player_address: params?.playerAddress,
    limit: params?.limit,
    offset: params?.offset,
  });
  const result = await apiFetch<Record<string, unknown>>(`${baseUrl}/activity${qs}`, fetchOpts(ctx));
  const { total, limit: resLimit, offset: resOffset } = extractPagination(result, { limit: params?.limit, offset: params?.offset });
  return {
    data: (result.data as Record<string, unknown>[]).map((item) => snakeToCamel<ActivityEvent>(item)),
    total,
    limit: resLimit,
    offset: resOffset,
  };
}

/**
 * Fetch platform-wide activity stats.
 */
export async function getActivityStats(
  baseUrl: string,
  ctx?: ApiContext,
): Promise<PlatformStats> {
  const result = await apiFetch<{ data: Record<string, unknown> }>(
    `${baseUrl}/activity/stats`,
    fetchOpts(ctx),
  );
  return snakeToCamel<PlatformStats>(result.data);
}

/**
 * Fetch platform-wide prize stats.
 */
export async function getPrizeStats(
  baseUrl: string,
  ctx?: ApiContext,
): Promise<PrizeStats> {
  const result = await apiFetch<{ data: Record<string, unknown> }>(
    `${baseUrl}/activity/prize-stats`,
    fetchOpts(ctx),
  );
  return snakeToCamel<PrizeStats>(result.data);
}
