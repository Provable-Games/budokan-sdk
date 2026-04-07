import { useState, useEffect, useCallback } from "react";
import type { PlatformStats, PrizeStats } from "../types/activity.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UseActivityStatsResult {
  stats: PlatformStats | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch platform-wide activity stats.
 */
export function useActivityStats(): UseActivityStatsResult {
  const client = useBudokanClient();
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setStats, setError);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.getActivityStats();
      setStats(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { fetch(); }, [fetch]);

  return { stats, loading, error, refetch: fetch };
}

export interface UsePrizeStatsResult {
  prizeStats: PrizeStats | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}
