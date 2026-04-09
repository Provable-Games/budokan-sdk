import { useState, useEffect, useCallback } from "react";
import type { RewardClaim, RewardClaimSummary } from "../types/prize.js";
import type { PaginatedResult } from "../types/common.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UseRewardClaimsResult {
  rewardClaims: PaginatedResult<RewardClaim> | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch reward claims for a tournament.
 */
export function useRewardClaims(
  tournamentId: string | undefined,
  params?: { limit?: number; offset?: number },
): UseRewardClaimsResult {
  const client = useBudokanClient();
  const [rewardClaims, setRewardClaims] = useState<PaginatedResult<RewardClaim> | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setRewardClaims, setError);

  const paramsKey = JSON.stringify(params);

  const fetch = useCallback(async () => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTournamentRewardClaims(tournamentId, params);
      setRewardClaims(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tournamentId, paramsKey]);

  useEffect(() => { fetch(); }, [fetch]);

  return { rewardClaims, loading, error, refetch: fetch };
}

export interface UseRewardClaimsSummaryResult {
  summary: RewardClaimSummary | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch reward claims summary for a tournament.
 */
export function useRewardClaimsSummary(tournamentId: string | undefined): UseRewardClaimsSummaryResult {
  const client = useBudokanClient();
  const [summary, setSummary] = useState<RewardClaimSummary | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setSummary, setError);

  const fetch = useCallback(async () => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTournamentRewardClaimsSummary(tournamentId);
      setSummary(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [client, tournamentId]);

  useEffect(() => { fetch(); }, [fetch]);

  return { summary, loading, error, refetch: fetch };
}
