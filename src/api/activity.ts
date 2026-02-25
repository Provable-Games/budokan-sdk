import type { ActivityEvent, ActivityParams, PlatformStats } from "../types/activity.js";
import type { PaginatedResult } from "../types/common.js";
import { apiFetch, buildQueryString } from "./base.js";
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
  const result = await apiFetch<{
    data: Record<string, unknown>[];
    total?: number;
    limit: number;
    offset: number;
  }>(`${baseUrl}/activity${qs}`, fetchOpts(ctx));
  return {
    data: result.data.map((item) => snakeToCamel<ActivityEvent>(item)),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
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
