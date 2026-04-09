import type { Tournament, TournamentListParams, QualificationEntry } from "../types/tournament.js";
import type { LeaderboardEntry } from "../types/leaderboard.js";
import type { Registration } from "../types/registration.js";
import type { Prize, RewardClaim, RewardClaimSummary, PrizeAggregation } from "../types/prize.js";
import type { PaginatedResult } from "../types/common.js";
import { apiFetch, buildQueryString, extractPagination } from "./base.js";
import type { ApiFetchOptions } from "./base.js";
import { snakeToCamel } from "../utils/mappers.js";

/** Normalize tournament: ensure both `id` and `tournamentId` exist */
function normalizeTournament(raw: Record<string, unknown>): Tournament {
  const t = snakeToCamel<Tournament & { id?: string }>(raw);
  // API returns `id`, SDK type uses `tournamentId` — keep both in sync
  const id = t.id ?? t.tournamentId;
  return { ...t, id, tournamentId: id };
}

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
    sort: params?.sort,
    from_id: params?.fromId,
    exclude_ids: params?.excludeIds?.join(","),
    whitelisted_extensions: params?.whitelistedExtensions?.join(","),
    include_prizes: params?.includePrizeSummary,
  });
  const result = await apiFetch<Record<string, unknown>>(`${baseUrl}/tournaments${qs}`, fetchOpts(ctx));
  const { total, limit: resLimit, offset: resOffset } = extractPagination(result, { limit: params?.limit, offset: params?.offset });
  return {
    data: (result.data as Record<string, unknown>[]).map((item) => normalizeTournament(item)),
    total,
    limit: resLimit,
    offset: resOffset,
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
  return normalizeTournament(result.data);
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
  params?: { playerAddress?: string; gameTokenIds?: string[]; hasSubmitted?: boolean; isBanned?: boolean; limit?: number; offset?: number },
  ctx?: ApiContext,
): Promise<PaginatedResult<Registration>> {
  const qs = buildQueryString({
    player_address: params?.playerAddress,
    game_token_ids: params?.gameTokenIds?.join(","),
    has_submitted: params?.hasSubmitted,
    is_banned: params?.isBanned,
    limit: params?.limit,
    offset: params?.offset,
  });
  const result = await apiFetch<Record<string, unknown>>(`${baseUrl}/tournaments/${tournamentId}/registrations${qs}`, fetchOpts(ctx));
  const { total, limit: resLimit, offset: resOffset } = extractPagination(result, { limit: params?.limit, offset: params?.offset });
  return {
    data: (result.data as Record<string, unknown>[]).map((item) => snakeToCamel<Registration>(item)),
    total,
    limit: resLimit,
    offset: resOffset,
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

/**
 * Fetch reward claims for a tournament.
 */
export async function getTournamentRewardClaims(
  baseUrl: string,
  tournamentId: string,
  params?: { limit?: number; offset?: number },
  ctx?: ApiContext,
): Promise<PaginatedResult<RewardClaim>> {
  const qs = buildQueryString({
    limit: params?.limit,
    offset: params?.offset,
  });
  const result = await apiFetch<Record<string, unknown>>(`${baseUrl}/tournaments/${tournamentId}/reward-claims${qs}`, fetchOpts(ctx));
  const { total, limit: resLimit, offset: resOffset } = extractPagination(result, { limit: params?.limit, offset: params?.offset });
  return {
    data: (result.data as Record<string, unknown>[]).map((item) => snakeToCamel<RewardClaim>(item)),
    total,
    limit: resLimit,
    offset: resOffset,
  };
}

/**
 * Fetch reward claims summary for a tournament.
 */
export async function getTournamentRewardClaimsSummary(
  baseUrl: string,
  tournamentId: string,
  ctx?: ApiContext,
): Promise<RewardClaimSummary> {
  const result = await apiFetch<{ data: Record<string, unknown> }>(
    `${baseUrl}/tournaments/${tournamentId}/reward-claims/summary`,
    fetchOpts(ctx),
  );
  return snakeToCamel<RewardClaimSummary>(result.data);
}

/**
 * Fetch qualifications for a tournament.
 */
export async function getTournamentQualifications(
  baseUrl: string,
  tournamentId: string,
  params?: { limit?: number; offset?: number },
  ctx?: ApiContext,
): Promise<PaginatedResult<QualificationEntry>> {
  const qs = buildQueryString({
    limit: params?.limit,
    offset: params?.offset,
  });
  const result = await apiFetch<Record<string, unknown>>(`${baseUrl}/tournaments/${tournamentId}/qualifications${qs}`, fetchOpts(ctx));
  const { total, limit: resLimit, offset: resOffset } = extractPagination(result, { limit: params?.limit, offset: params?.offset });
  return {
    data: (result.data as Record<string, unknown>[]).map((item) => snakeToCamel<QualificationEntry>(item)),
    total,
    limit: resLimit,
    offset: resOffset,
  };
}

/**
 * Fetch prize aggregation for a tournament.
 */
export async function getTournamentPrizeAggregation(
  baseUrl: string,
  tournamentId: string,
  ctx?: ApiContext,
): Promise<PrizeAggregation[]> {
  const qs = buildQueryString({ include_aggregation: true });
  const result = await apiFetch<{ data: Record<string, unknown>[] }>(
    `${baseUrl}/tournaments/${tournamentId}/prizes${qs}`,
    fetchOpts(ctx),
  );
  return result.data.map((item) => snakeToCamel<PrizeAggregation>(item));
}
