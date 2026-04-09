import { useState, useEffect, useCallback } from "react";
import type { QualificationEntry } from "../types/tournament.js";
import type { PaginatedResult } from "../types/common.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UseQualificationsResult {
  qualifications: PaginatedResult<QualificationEntry> | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch qualification entries for a tournament.
 */
export function useQualifications(
  tournamentId: string | undefined,
  params?: { limit?: number; offset?: number },
): UseQualificationsResult {
  const client = useBudokanClient();
  const [qualifications, setQualifications] = useState<PaginatedResult<QualificationEntry> | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setQualifications, setError);

  const paramsKey = JSON.stringify(params);

  const fetch = useCallback(async () => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTournamentQualifications(tournamentId, params);
      setQualifications(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tournamentId, paramsKey]);

  useEffect(() => { fetch(); }, [fetch]);

  return { qualifications, loading, error, refetch: fetch };
}
