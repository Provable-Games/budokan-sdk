import type { Tournament, TournamentListParams } from "../types/tournament.js";
import type { LeaderboardEntry } from "../types/leaderboard.js";
import type { Registration } from "../types/registration.js";
import type { Prize } from "../types/prize.js";
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
 * Fetch a paginated list of tournaments.
 */
export async function getTournaments(
  baseUrl: string,
  params?: TournamentListParams,
  ctx?: ApiContext,
): Promise<PaginatedResult<Tournament>> {
  const qs = buildQueryString({
    game_address: params?.gameAddress,
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
  }>(`${baseUrl}/tournaments${qs}`, fetchOpts(ctx));
  return {
    data: result.data.map((item) => snakeToCamel<Tournament>(item)),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  };
}

/**
 * Fetch a single tournament by ID.
 */
export async function getTournament(
  baseUrl: string,
  tournamentId: string,
  ctx?: ApiContext,
): Promise<Tournament> {
  const result = await apiFetch<{ data: Record<string, unknown> }>(
    `${baseUrl}/tournaments/${tournamentId}`,
    fetchOpts(ctx),
  );
  return snakeToCamel<Tournament>(result.data);
}

/**
 * Fetch the leaderboard for a tournament.
 */
export async function getTournamentLeaderboard(
  baseUrl: string,
  tournamentId: string,
  ctx?: ApiContext,
): Promise<LeaderboardEntry[]> {
  const result = await apiFetch<{ data: Record<string, unknown>[] }>(
    `${baseUrl}/tournaments/${tournamentId}/leaderboard`,
    fetchOpts(ctx),
  );
  return result.data.map((item) => snakeToCamel<LeaderboardEntry>(item));
}

/**
 * Fetch registrations for a tournament.
 */
export async function getTournamentRegistrations(
  baseUrl: string,
  tournamentId: string,
  params?: { limit?: number; offset?: number },
  ctx?: ApiContext,
): Promise<PaginatedResult<Registration>> {
  const qs = buildQueryString({
    limit: params?.limit,
    offset: params?.offset,
  });
  const result = await apiFetch<{
    data: Record<string, unknown>[];
    total?: number;
    limit: number;
    offset: number;
  }>(`${baseUrl}/tournaments/${tournamentId}/registrations${qs}`, fetchOpts(ctx));
  return {
    data: result.data.map((item) => snakeToCamel<Registration>(item)),
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  };
}

/**
 * Fetch prizes for a tournament.
 */
export async function getTournamentPrizes(
  baseUrl: string,
  tournamentId: string,
  ctx?: ApiContext,
): Promise<Prize[]> {
  const result = await apiFetch<{ data: Record<string, unknown>[] }>(
    `${baseUrl}/tournaments/${tournamentId}/prizes`,
    fetchOpts(ctx),
  );
  return result.data.map((item) => snakeToCamel<Prize>(item));
}
