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
export function useQualifications(tournamentId: string | undefined): UseQualificationsResult {
  const client = useBudokanClient();
  const [qualifications, setQualifications] = useState<PaginatedResult<QualificationEntry> | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setQualifications, setError);

  const fetch = useCallback(async () => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTournamentQualifications(tournamentId);
      setQualifications(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [client, tournamentId]);

  useEffect(() => { fetch(); }, [fetch]);

  return { qualifications, loading, error, refetch: fetch };
}
