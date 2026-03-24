import { useState, useEffect, useCallback } from "react";
import type { Phase } from "../types/tournament.js";
import { useBudokanClient } from "./context.js";

export interface UseTournamentCountResult {
  count: number | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to fetch the total count of tournaments matching a phase filter.
 */
export function useTournamentCount(phase?: Phase): UseTournamentCountResult {
  const client = useBudokanClient();
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(() => {
    setLoading(true);
    setError(null);
    client
      .getTournaments({ phase, limit: 1 })
      .then((r) => setCount(r.total ?? 0))
      .catch(setError)
      .finally(() => setLoading(false));
  }, [client, phase]);

  useEffect(() => { fetch(); }, [fetch]);

  return { count, loading, error, refetch: fetch };
}

/**
 * Hook to fetch the total count of tournaments a player is registered for.
 */
export function usePlayerTournamentCount(
  address: string | undefined,
  phase?: Phase,
): UseTournamentCountResult {
  const client = useBudokanClient();
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(!!address);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(() => {
    if (!address) return;
    setLoading(true);
    setError(null);
    client
      .getPlayerTournaments(address, { phase, limit: 1 })
      .then((r) => setCount(r.total ?? 0))
      .catch(setError)
      .finally(() => setLoading(false));
  }, [client, address, phase]);

  useEffect(() => { fetch(); }, [fetch]);

  return { count, loading, error, refetch: fetch };
}
