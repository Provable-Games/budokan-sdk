import type {
  BracketListParams,
  BracketRegistration,
  IndexedBracket,
  IndexedBracketDetail,
  PlayerBracketRegistration,
} from "../types/indexedBracket.js";
import { BudokanApiError } from "../errors/index.js";
import { apiFetch, buildQueryString } from "./base.js";
import type { ApiFetchOptions } from "./base.js";

interface ApiContext {
  retryAttempts?: number;
  retryDelay?: number;
  timeout?: number;
}

function fetchOpts(ctx?: ApiContext): Partial<ApiFetchOptions> {
  return { retryAttempts: ctx?.retryAttempts, retryDelay: ctx?.retryDelay, timeout: ctx?.timeout };
}

/** Indexed on-chain brackets, newest first. */
export async function getBrackets(
  baseUrl: string,
  params?: BracketListParams,
  ctx?: ApiContext,
): Promise<{ data: IndexedBracket[]; limit: number; offset: number }> {
  const qs = buildQueryString({
    game_address: params?.gameAddress,
    status: params?.status?.length ? params.status.join(",") : undefined,
    contract_address: params?.contractAddress,
    limit: params?.limit,
    offset: params?.offset,
  });
  return apiFetch(`${baseUrl}/brackets${qs}`, fetchOpts(ctx));
}

/** One bracket with its drawn seats and built matches; null when not indexed. */
export async function getBracket(
  baseUrl: string,
  bracketId: string,
  contractAddress?: string,
  ctx?: ApiContext,
): Promise<IndexedBracketDetail | null> {
  const qs = buildQueryString({ contract_address: contractAddress });
  try {
    const result = await apiFetch<{ data: IndexedBracketDetail }>(
      `${baseUrl}/brackets/${encodeURIComponent(bracketId)}${qs}`,
      fetchOpts(ctx),
    );
    return result.data;
  } catch (e) {
    if (e instanceof BudokanApiError && e.status === 404) return null;
    throw e;
  }
}

/** A bracket's registrations in registration order, optionally for one player. */
export async function getBracketRegistrations(
  baseUrl: string,
  bracketId: string,
  params?: { player?: string; contractAddress?: string; limit?: number; offset?: number },
  ctx?: ApiContext,
): Promise<BracketRegistration[]> {
  const qs = buildQueryString({
    player: params?.player,
    contract_address: params?.contractAddress,
    limit: params?.limit,
    offset: params?.offset,
  });
  const result = await apiFetch<{ data: BracketRegistration[] }>(
    `${baseUrl}/brackets/${encodeURIComponent(bracketId)}/registrations${qs}`,
    fetchOpts(ctx),
  );
  return result.data;
}

/**
 * Every bracket a player registered for. Before the draw this is the only record of a
 * registration: seats exist only once the field is drawn.
 */
export async function getPlayerBracketRegistrations(
  baseUrl: string,
  player: string,
  contractAddress?: string,
  ctx?: ApiContext,
): Promise<PlayerBracketRegistration[]> {
  const qs = buildQueryString({ player, contract_address: contractAddress });
  const result = await apiFetch<{ data: PlayerBracketRegistration[] }>(
    `${baseUrl}/brackets/registrations${qs}`,
    fetchOpts(ctx),
  );
  return result.data;
}
