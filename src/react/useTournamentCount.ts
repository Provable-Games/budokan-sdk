import { useState, useEffect, useCallback } from "react";
import type { Phase } from "../types/tournament.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UseTournamentCountResult {
  count: number | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch the total count of tournaments matching a phase filter.
 */
export function useTournamentCount(phase?: Phase): UseTournamentCountResult {
  const client = useBudokanClient();
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setCount, setError);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTournaments({ phase, limit: 1 });
      setCount(result.total ?? 0);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [client, phase]);

  useEffect(() => { fetch(); }, [fetch]);

  return { count, loading, error, refetch: fetch };
}

