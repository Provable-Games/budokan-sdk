import { useState, useEffect, useCallback } from "react";
import type { Tournament, TournamentListParams } from "../types/tournament.js";
import type { PaginatedResult } from "../types/common.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UseTournamentsResult {
  tournaments: PaginatedResult<Tournament> | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch a paginated list of tournaments.
 * Pass `undefined` to skip fetching (useful for conditional queries).
 */
export function useTournaments(params?: TournamentListParams): UseTournamentsResult {
  const client = useBudokanClient();
  const [tournaments, setTournaments] = useState<PaginatedResult<Tournament> | null>(null);
  const [loading, setLoading] = useState(!!params);
  const [error, setError] = useState<Error | null>(null);

  const paramsKey = JSON.stringify(params);

  useResetOnClient(client, setTournaments, setError);

  const fetch = useCallback(async () => {
    if (params === undefined) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getTournaments(params);
      setTournaments(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, paramsKey]);

  useEffect(() => { fetch(); }, [fetch]);

  return { tournaments, loading, error, refetch: fetch };
}

export interface UseTournamentResult {
  tournament: Tournament | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch a single tournament by ID.
 */
export function useTournament(tournamentId: string | undefined): UseTournamentResult {
  const client = useBudokanClient();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setTournament, setError);

  const fetch = useCallback(async () => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await client.getTournament(tournamentId);
      setTournament(data);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [client, tournamentId]);

  useEffect(() => { fetch(); }, [fetch]);

  return { tournament, loading, error, refetch: fetch };
}
