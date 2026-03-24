import { useState, useEffect, useCallback } from "react";
import type { PrizeAggregation } from "../types/prize.js";
import { useBudokanClient } from "./context.js";

export interface UsePrizeAggregationResult {
  prizeAggregation: PrizeAggregation[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to fetch prize aggregation for a tournament.
 */
export function usePrizeAggregation(tournamentId: string | undefined): UsePrizeAggregationResult {
  const client = useBudokanClient();
  const [prizeAggregation, setPrizeAggregation] = useState<PrizeAggregation[] | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(() => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    client
      .getTournamentPrizeAggregation(tournamentId)
      .then(setPrizeAggregation)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [client, tournamentId]);

  useEffect(() => { fetch(); }, [fetch]);

  return { prizeAggregation, loading, error, refetch: fetch };
}
