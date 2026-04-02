import { useState, useEffect, useCallback } from "react";
import type { Prize } from "../types/prize.js";
import type { PrizeStats } from "../types/activity.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UsePrizesResult {
  prizes: Prize[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to fetch prizes for a tournament.
 */
export function usePrizes(tournamentId: string | undefined): UsePrizesResult {
  const client = useBudokanClient();
  const [prizes, setPrizes] = useState<Prize[] | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setPrizes, setError);

  const fetch = useCallback(() => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    client
      .getTournamentPrizes(tournamentId)
      .then(setPrizes)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [client, tournamentId]);

  useEffect(() => { fetch(); }, [fetch]);

  return { prizes, loading, error, refetch: fetch };
}

export interface UsePrizeStatsResult {
  prizeStats: PrizeStats | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to fetch platform-wide prize stats.
 */
export function usePrizeStats(): UsePrizeStatsResult {
  const client = useBudokanClient();
  const [prizeStats, setPrizeStats] = useState<PrizeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setPrizeStats, setError);

  const fetch = useCallback(() => {
    setLoading(true);
    setError(null);
    client
      .getPrizeStats()
      .then(setPrizeStats)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [client]);

  useEffect(() => { fetch(); }, [fetch]);

  return { prizeStats, loading, error, refetch: fetch };
}
