import { useMemo } from "react";
import { useTokens } from "@provable-games/denshokan-sdk/react";
import type { Phase, Tournament, TournamentListParams } from "../types/tournament.js";
import type { Registration } from "../types/registration.js";
import type { PaginatedResult } from "../types/common.js";
import { useBudokanClient } from "./context.js";
import { useTournaments } from "./useTournaments.js";
import { useRegistrations } from "./useRegistrations.js";
import type { UseTournamentsResult } from "./useTournaments.js";
import type { UseTournamentCountResult } from "./useTournamentCount.js";
import type { UseRegistrationsResult } from "./useRegistrations.js";

// Cap on the number of tokens we ask denshokan for in a single shot. Realistic
// users own tokens across far fewer tournaments than this — the cap is here to
// keep the fan-out bounded if a wallet is unusually saturated. Same number as
// denshokan's per-call default elsewhere in the codebase.
const MAX_OWNED_TOKENS = 1000;

const emptyPage = <T,>(limit: number, offset: number): PaginatedResult<T> => ({
  data: [],
  total: 0,
  limit,
  offset,
});

/**
 * Resolve the unique tournament IDs an address currently holds Budokan-minted
 * tokens for. Returns `null` while denshokan is still loading or while the
 * inputs are insufficient to query, an empty array once we know the owner has
 * no Budokan tokens, or the deduped id list.
 *
 * `contextId` narrows the denshokan query to a single tournament so we don't
 * fan out across every Budokan token the owner holds when the caller only
 * cares about one tournament.
 */
function useOwnedTournamentIds(
  owner: string | undefined,
  contextId?: number,
): { tournamentIds: string[] | null; loading: boolean } {
  const client = useBudokanClient();
  const budokanAddress = client.clientConfig.budokanAddress;
  const enabled = !!owner && !!budokanAddress;

  const { data, isLoading } = useTokens(
    enabled
      ? {
          owner,
          minterAddress: budokanAddress,
          hasContext: true,
          ...(contextId != null ? { contextId } : {}),
          limit: MAX_OWNED_TOKENS,
        }
      : undefined,
  );

  const tournamentIds = useMemo(() => {
    if (!enabled) return null;
    if (!data?.data) return null;
    const ids = new Set<string>();
    for (const t of data.data) {
      if (t.contextId) ids.add(String(t.contextId));
    }
    return [...ids];
  }, [enabled, data]);

  return { tournamentIds, loading: isLoading };
}

/**
 * Tournaments where `owner` currently holds at least one Budokan-minted token.
 * Stitches denshokan ownership → unique `contextId`s → `useTournaments`
 * filtered by those IDs. Stays correct under transfers; transferred tokens
 * drop out of the result, received tokens appear.
 *
 * Requires the consuming app to wrap its tree in a `DenshokanProvider`
 * alongside the `BudokanProvider`.
 */
export function useTournamentsByOwner(
  owner: string | undefined,
  params?: {
    phase?: Phase;
    limit?: number;
    offset?: number;
    sort?: TournamentListParams["sort"];
    includePrizeSummary?: TournamentListParams["includePrizeSummary"];
  },
): UseTournamentsResult {
  const { tournamentIds, loading: tokensLoading } = useOwnedTournamentIds(owner);

  const inner = useTournaments(
    tournamentIds && tournamentIds.length > 0
      ? {
          tournamentIds,
          phase: params?.phase,
          limit: params?.limit,
          offset: params?.offset,
          sort: params?.sort,
          includePrizeSummary: params?.includePrizeSummary,
        }
      : undefined,
  );

  // Owner has no Budokan tokens → short-circuit to a fully-resolved empty
  // page rather than leaving the consumer in a stuck `null` state.
  if (tournamentIds !== null && tournamentIds.length === 0) {
    return {
      tournaments: emptyPage<Tournament>(
        params?.limit ?? 50,
        params?.offset ?? 0,
      ),
      loading: false,
      error: null,
      refetch: async () => {},
    };
  }

  return {
    tournaments: inner.tournaments,
    loading: tokensLoading || inner.loading,
    error: inner.error,
    refetch: inner.refetch,
  };
}

/**
 * Count of tournaments where `owner` currently holds a Budokan-minted token.
 * When `phase` is omitted the count comes for free from the denshokan result;
 * when phase-filtered it makes a second `useTournaments` call (with limit=1)
 * and reads `.total`.
 */
export function useTournamentsByOwnerCount(
  owner: string | undefined,
  params?: { phase?: Phase },
): UseTournamentCountResult {
  const { tournamentIds, loading: tokensLoading } = useOwnedTournamentIds(owner);

  // For phase-filtered counts we still need to ask the API — denshokan tokens
  // don't carry tournament phase. Limit=1 keeps the response cheap; we only
  // care about `total`.
  const phaseFilter = params?.phase;
  const filtered = useTournaments(
    phaseFilter && tournamentIds && tournamentIds.length > 0
      ? { tournamentIds, phase: phaseFilter, limit: 1 }
      : undefined,
  );

  if (tournamentIds === null) {
    return {
      count: null,
      loading: tokensLoading,
      error: null,
      refetch: async () => {},
    };
  }
  if (tournamentIds.length === 0) {
    return {
      count: 0,
      loading: false,
      error: null,
      refetch: async () => {},
    };
  }
  if (!phaseFilter) {
    // Unfiltered count is just the unique-tournament-id count from denshokan.
    return {
      count: tournamentIds.length,
      loading: false,
      error: null,
      refetch: async () => {},
    };
  }
  return {
    count: filtered.tournaments?.total ?? null,
    loading: filtered.loading,
    error: filtered.error,
    refetch: async () => {},
  };
}

/**
 * Registrations in `tournamentId` for tokens that `owner` currently holds.
 * Source of truth is denshokan ownership scoped to the tournament's
 * `contextId`; registration metadata (ban / submission / entry-number) is
 * fetched by `gameTokenIds` filter against the tournament.
 */
export function useRegistrationsByOwner(
  tournamentId: string | undefined,
  owner: string | undefined,
  params?: {
    hasSubmitted?: boolean;
    isBanned?: boolean;
    limit?: number;
    offset?: number;
  },
): UseRegistrationsResult {
  const client = useBudokanClient();
  const budokanAddress = client.clientConfig.budokanAddress;
  const contextId = tournamentId ? Number(tournamentId) : undefined;
  const enabled =
    !!owner && !!budokanAddress && tournamentId != null && contextId !== undefined;

  const { data: tokensResult, isLoading: tokensLoading } = useTokens(
    enabled
      ? {
          owner,
          minterAddress: budokanAddress,
          contextId,
          limit: MAX_OWNED_TOKENS,
        }
      : undefined,
  );

  const ownedGameTokenIds = useMemo(() => {
    if (!enabled) return null;
    if (!tokensResult?.data) return null;
    const ids: string[] = [];
    for (const t of tokensResult.data) {
      if (t.tokenId == null) continue;
      try {
        ids.push(BigInt(String(t.tokenId)).toString());
      } catch {
        // Non-numeric token id — skip rather than poison the filter.
      }
    }
    return ids;
  }, [enabled, tokensResult]);

  const inner = useRegistrations(
    ownedGameTokenIds && ownedGameTokenIds.length > 0 ? tournamentId : undefined,
    ownedGameTokenIds && ownedGameTokenIds.length > 0
      ? { ...params, gameTokenIds: ownedGameTokenIds }
      : undefined,
  );

  if (ownedGameTokenIds !== null && ownedGameTokenIds.length === 0) {
    return {
      registrations: emptyPage<Registration>(
        params?.limit ?? 50,
        params?.offset ?? 0,
      ),
      loading: false,
      error: null,
      refetch: async () => {},
    };
  }

  return {
    registrations: inner.registrations,
    loading: tokensLoading || inner.loading,
    error: inner.error,
    refetch: inner.refetch,
  };
}
