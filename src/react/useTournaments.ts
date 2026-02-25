import { useState, useEffect, useCallback } from "react";
import type { Tournament, TournamentListParams } from "../types/tournament.js";
import type { PaginatedResult } from "../types/common.js";
import { useBudokanClient } from "./context.js";

export interface UseTournamentsResult {
  tournaments: PaginatedResult<Tournament> | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to fetch a paginated list of tournaments.
 */
export function useTournaments(params?: TournamentListParams): UseTournamentsResult {
  const client = useBudokanClient();
  const [tournaments, setTournaments] = useState<PaginatedResult<Tournament> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const paramsKey = JSON.stringify(params);

  const fetch = useCallback(() => {
    setLoading(true);
    setError(null);
    client
      .getTournaments(params)
      .then(setTournaments)
      .catch(setError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, paramsKey]);

  useEffect(() => { fetch(); }, [fetch]);

  return { tournaments, loading, error, refetch: fetch };
}

export interface UseTournamentResult {
  tournament: Tournament | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to fetch a single tournament by ID.
 */
export function useTournament(tournamentId: string | undefined): UseTournamentResult {
  const client = useBudokanClient();
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [loading, setLoading] = useState(!!tournamentId);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(() => {
    if (!tournamentId) return;
    setLoading(true);
    setError(null);
    client
      .getTournament(tournamentId)
      .then(setTournament)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [client, tournamentId]);

  useEffect(() => { fetch(); }, [fetch]);

  return { tournament, loading, error, refetch: fetch };
}
