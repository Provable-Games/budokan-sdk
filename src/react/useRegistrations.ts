import { useState, useEffect, useCallback } from "react";
import type { Registration } from "../types/registration.js";
import type { PaginatedResult } from "../types/common.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UseRegistrationsResult {
  registrations: PaginatedResult<Registration> | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch registrations for a tournament.
 */
export function useRegistrations(
  tournamentId: string | undefined,
  params?: { playerAddress?: string; limit?: number; offset?: number },
): UseRegistrationsResult {
  const client = useBudokanClient();
  const [registrations, setRegistrations] = useState<PaginatedResult<Registration> | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setRegistrations, setError);

  const paramsKey = JSON.stringify(params);

  const fetch = useCallback(async () => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTournamentRegistrations(tournamentId, params);
      setRegistrations(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tournamentId, paramsKey]);

  useEffect(() => { fetch(); }, [fetch]);

  return { registrations, loading, error, refetch: fetch };
}
