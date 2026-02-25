import { useState, useEffect, useCallback } from "react";
import type { LeaderboardEntry } from "../types/leaderboard.js";
import { useBudokanClient } from "./context.js";

export interface UseLeaderboardResult {
  leaderboard: LeaderboardEntry[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to fetch the leaderboard for a tournament.
 */
export function useLeaderboard(tournamentId: string | undefined): UseLeaderboardResult {
  const client = useBudokanClient();
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[] | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(() => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    client
      .getTournamentLeaderboard(tournamentId)
      .then(setLeaderboard)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [client, tournamentId]);

  useEffect(() => { fetch(); }, [fetch]);

  return { leaderboard, loading, error, refetch: fetch };
}
