import { useState, useEffect, useCallback } from "react";
import type { PrizeAggregation } from "../types/prize.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UsePrizeAggregationResult {
  prizeAggregation: PrizeAggregation[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch prize aggregation for a tournament.
 */
export function usePrizeAggregation(tournamentId: string | undefined): UsePrizeAggregationResult {
  const client = useBudokanClient();
  const [prizeAggregation, setPrizeAggregation] = useState<PrizeAggregation[] | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setPrizeAggregation, setError);

  const fetch = useCallback(async () => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTournamentPrizeAggregation(tournamentId);
      setPrizeAggregation(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [client, tournamentId]);

  useEffect(() => { fetch(); }, [fetch]);

  return { prizeAggregation, loading, error, refetch: fetch };
}
