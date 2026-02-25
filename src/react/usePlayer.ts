import { useState, useEffect, useCallback } from "react";
import type { PlayerStats, PlayerTournament } from "../types/player.js";
import type { PaginatedResult } from "../types/common.js";
import { useBudokanClient } from "./context.js";

export interface UsePlayerResult {
  tournaments: PaginatedResult<PlayerTournament> | null;
  stats: PlayerStats | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Hook to fetch a player's tournament history and stats.
 */
export function usePlayer(address: string | undefined): UsePlayerResult {
  const client = useBudokanClient();
  const [tournaments, setTournaments] = useState<PaginatedResult<PlayerTournament> | null>(null);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [loading, setLoading] = useState(!!address);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(() => {
    if (!address) return;
    setLoading(true);
    setError(null);
    Promise.all([
      client.getPlayerTournaments(address),
      client.getPlayerStats(address),
    ])
      .then(([tournamentsResult, statsResult]) => {
        setTournaments(tournamentsResult);
        setStats(statsResult);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [client, address]);

  useEffect(() => { fetch(); }, [fetch]);

  return { tournaments, stats, loading, error };
}

export interface UsePlayerStatsResult {
  stats: PlayerStats | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to fetch stats for a player.
 */
export function usePlayerStats(address: string | undefined): UsePlayerStatsResult {
  const client = useBudokanClient();
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [loading, setLoading] = useState(!!address);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(() => {
    if (!address) return;
    setLoading(true);
    setError(null);
    client
      .getPlayerStats(address)
      .then(setStats)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [client, address]);

  useEffect(() => { fetch(); }, [fetch]);

  return { stats, loading, error, refetch: fetch };
}

export interface UsePlayerTournamentsResult {
  tournaments: PaginatedResult<PlayerTournament> | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Hook to fetch tournaments a player has registered for.
 */
export function usePlayerTournaments(address: string | undefined): UsePlayerTournamentsResult {
  const client = useBudokanClient();
  const [tournaments, setTournaments] = useState<PaginatedResult<PlayerTournament> | null>(null);
  const [loading, setLoading] = useState(!!address);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(() => {
    if (!address) return;
    setLoading(true);
    setError(null);
    client
      .getPlayerTournaments(address)
      .then(setTournaments)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [client, address]);

  useEffect(() => { fetch(); }, [fetch]);

  return { tournaments, loading, error, refetch: fetch };
}
