import { useState, useEffect, useCallback } from "react";
import type { PlayerStats, PlayerTournament, PlayerTournamentParams } from "../types/player.js";
import type { PaginatedResult } from "../types/common.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UsePlayerResult {
  tournaments: PaginatedResult<PlayerTournament> | null;
  stats: PlayerStats | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Hook to fetch a player's tournament history and stats.
 */
export function usePlayer(
  address: string | undefined,
  params?: PlayerTournamentParams,
): UsePlayerResult {
  const client = useBudokanClient();
  const [tournaments, setTournaments] = useState<PaginatedResult<PlayerTournament> | null>(null);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [loading, setLoading] = useState(!!address);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setTournaments, setStats, setError);

  const paramsKey = JSON.stringify(params);

  const fetch = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const [tournamentsResult, statsResult] = await Promise.all([
        client.getPlayerTournaments(address, params),
        client.getPlayerStats(address),
      ]);
      setTournaments(tournamentsResult);
      setStats(statsResult);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, address, paramsKey]);

  useEffect(() => { fetch(); }, [fetch]);

  return { tournaments, stats, loading, error };
}

export interface UsePlayerStatsResult {
  stats: PlayerStats | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch stats for a player.
 */
export function usePlayerStats(address: string | undefined): UsePlayerStatsResult {
  const client = useBudokanClient();
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [loading, setLoading] = useState(!!address);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setStats, setError);

  const fetch = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getPlayerStats(address);
      setStats(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [client, address]);

  useEffect(() => { fetch(); }, [fetch]);

  return { stats, loading, error, refetch: fetch };
}

export interface UsePlayerTournamentsResult {
  tournaments: PaginatedResult<PlayerTournament> | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch tournaments a player has registered for.
 */
export function usePlayerTournaments(
  address: string | undefined,
  params?: PlayerTournamentParams,
): UsePlayerTournamentsResult {
  const client = useBudokanClient();
  const [tournaments, setTournaments] = useState<PaginatedResult<PlayerTournament> | null>(null);
  const [loading, setLoading] = useState(!!address);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setTournaments, setError);

  const paramsKey = JSON.stringify(params);

  const fetch = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      const result = await client.getPlayerTournaments(address, params);
      setTournaments(result);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, address, paramsKey]);

  useEffect(() => { fetch(); }, [fetch]);

  return { tournaments, loading, error, refetch: fetch };
}
