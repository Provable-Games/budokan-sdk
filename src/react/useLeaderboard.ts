import { useState, useEffect, useCallback } from "react";
import type { LeaderboardEntry } from "../types/leaderboard.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UseLeaderboardResult {
  leaderboard: LeaderboardEntry[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch the leaderboard for a tournament.
 */
export function useLeaderboard(tournamentId: string | undefined): UseLeaderboardResult {
  const client = useBudokanClient();
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[] | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setLeaderboard, setError);

  const fetch = useCallback(async () => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTournamentLeaderboard(tournamentId);
      setLeaderboard(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [client, tournamentId]);

  useEffect(() => { fetch(); }, [fetch]);

  return { leaderboard, loading, error, refetch: fetch };
}
