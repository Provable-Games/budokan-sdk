import type { PlatformStats, PrizeStats } from "../types/activity.js";
import { apiFetch } from "./base.js";
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
