import { useState, useEffect, useCallback } from "react";
import type {
  BracketListParams,
  IndexedBracket,
  IndexedBracketDetail,
  PlayerBracketRegistration,
} from "../types/indexedBracket.js";
import { useBudokanClient } from "./context.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UseBracketsResult {
  brackets: IndexedBracket[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Indexed on-chain brackets, newest first. Pass `undefined` to skip fetching.
 */
export function useBrackets(params?: BracketListParams): UseBracketsResult {
  const client = useBudokanClient();
  const [brackets, setBrackets] = useState<IndexedBracket[] | null>(null);
  const [loading, setLoading] = useState(!!params);
  const [error, setError] = useState<Error | null>(null);
  const paramsKey = JSON.stringify(params);

  useResetOnClient(client, setBrackets, setError);

  const fetch = useCallback(async () => {
    if (params === undefined) return;
    setLoading(true);
    setError(null);
    try {
      setBrackets((await client.getBrackets(params)).data);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, paramsKey]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { brackets, loading, error, refetch: fetch };
}

export interface UseBracketResult {
  /** Null while loading, on error, or when the bracket is not indexed. */
  bracket: IndexedBracketDetail | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** One indexed bracket with seats and matches. Pass `undefined` to skip fetching. */
export function useBracket(bracketId?: string, contractAddress?: string): UseBracketResult {
  const client = useBudokanClient();
  const [bracket, setBracket] = useState<IndexedBracketDetail | null>(null);
  const [loading, setLoading] = useState(!!bracketId);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setBracket, setError);

  const fetch = useCallback(async () => {
    if (!bracketId) return;
    setLoading(true);
    setError(null);
    try {
      setBracket(await client.getBracket(bracketId, contractAddress));
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [client, bracketId, contractAddress]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { bracket, loading, error, refetch: fetch };
}

export interface UsePlayerBracketRegistrationsResult {
  registrations: PlayerBracketRegistration[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Every bracket a player registered for, including before the draw.
 * Pass `undefined` to skip fetching (e.g. while no wallet is connected).
 */
export function usePlayerBracketRegistrations(
  player?: string,
  contractAddress?: string,
): UsePlayerBracketRegistrationsResult {
  const client = useBudokanClient();
  const [registrations, setRegistrations] = useState<PlayerBracketRegistration[] | null>(null);
  const [loading, setLoading] = useState(!!player);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(client, setRegistrations, setError);

  const fetch = useCallback(async () => {
    if (!player) return;
    setLoading(true);
    setError(null);
    try {
      setRegistrations(await client.getPlayerBracketRegistrations(player, contractAddress));
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, [client, player, contractAddress]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { registrations, loading, error, refetch: fetch };
}
