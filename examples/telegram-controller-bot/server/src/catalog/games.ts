// Per-chain game catalog. Source of truth is budokan-sdk's game whitelist
// (`getWhitelistedGames`) — completing the migration the previous version of
// this file promised, and REVERSING its registry dependency on purpose.
//
// Budokan v2 removed the on-chain minigame registry, so there is nothing to
// enumerate — a game is offerable because it is whitelisted, full stop.
//
// The denshokan indexer is still queried, but ONLY to enrich a whitelisted
// game with indexed description/artwork. It never decides what is offered,
// and an outage no longer empties the picker. That distinction matters
// because the indexer must be the V2 one: a v1 indexer serves registry-era
// games that create_tournament rejects, and the old registry-∩-whitelist
// picker offered exactly those while hiding the games that work.
//
// The bot uses this for:
//   - /create's first picker (numbered list of offerable games)
//   - displaying friendly names elsewhere

import { createDenshokanClient, type DenshokanClient } from "@provable-games/denshokan-sdk";
import {
  CHAINS,
  findWhitelistedGame,
  getWhitelistedGames,
  type WhitelistedGame,
} from "@provable-games/budokan-sdk";
import { RpcProvider } from "starknet";

import type { Chain } from "../chat-state.ts";


export interface Game {
  contractAddress: string;
  name: string;
  description?: string;
  imageUrl?: string;
  /** Game homepage / client URL from the denshokan registry, when present. */
  clientUrl?: string;
  defaultEntryFeeToken?: string;
  defaultGameFeePercentage?: number;
  controllerOnly?: boolean;
  leaderboardAscending?: boolean;
  leaderboardGameMustBeOver?: boolean;
}

/** Friendly display fields for a game — name plus optional thumbnail/link. */
export interface GameInfo {
  name: string;
  imageUrl?: string;
  clientUrl?: string;
}

const clients = new Map<Chain, DenshokanClient>();

function getClient(chain: Chain): DenshokanClient {
  let client = clients.get(chain);
  if (!client) {
    // Point the RPC fallback at our dedicated node (rpc.provable.games) instead
    // of the SDK default (public api.cartridge.gg, shared + rate-limited). The
    // denshokan API stays primary; when it throttles/errors, getGames falls back
    // to this RPC and still returns the catalog — so the game picker keeps
    // working under load instead of showing "No games available".
    client = createDenshokanClient({ chain, rpcUrl: CHAINS[chain]?.rpcUrl });
    clients.set(chain, client);
  }
  return client;
}

/**
 * List games for a chain: the budokan-sdk whitelist, minus `disabled`
 * entries. Disabled entries are listed in the SDK for reference but cannot
 * host a tournament on this stack — offering one would walk the user through
 * a full /create flow that reverts at the transaction.
 *
 * The denshokan registry is consulted only to enrich an offered game with
 * indexed description/artwork; registry failure degrades to whitelist
 * metadata rather than an empty picker. Sorted by name for stable numbering
 * across reloads.
 */
export async function gamesForChain(chain: Chain): Promise<Game[]> {
  const offerable = getWhitelistedGames(chain).filter((g) => !g.disabled);

  let registry = new Map<string, { description?: string; imageUrl?: string; clientUrl?: string }>();
  try {
    const result = await getClient(chain).getGames({ limit: 100 });
    registry = new Map(result.data.map((g) => [g.contractAddress.toLowerCase(), g]));
  } catch {
    // Enrichment only — the picker works from the whitelist alone.
  }

  const games: Game[] = offerable.map((w) => {
    const reg = registry.get(w.contractAddress.toLowerCase());
    return {
      contractAddress: w.contractAddress,
      name: w.name,
      description: reg?.description,
      imageUrl: reg?.imageUrl ?? w.imageUrl,
      clientUrl: reg?.clientUrl ?? w.url,
      defaultEntryFeeToken: w.defaultEntryFeeToken,
      defaultGameFeePercentage: w.defaultGameFeePercentage,
      controllerOnly: w.controllerOnly,
      leaderboardAscending: w.leaderboardAscending,
      leaderboardGameMustBeOver: w.leaderboardGameMustBeOver,
    };
  });
  return games.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One-shot map of lowercase contractAddress → friendly game info (name +
 * optional thumbnail/link) for a chain. Replaces the per-command
 * `buildGameNameMap` helpers so every listing can surface real game names
 * (and, where available, logos) instead of raw 0x… addresses, without N+1
 * denshokan lookups. Returns an empty map on indexer failure — callers fall
 * back to a shortened address.
 */
export async function gameInfoMap(chain: Chain): Promise<Map<string, GameInfo>> {
  const games = await gamesForChain(chain);
  const map = new Map<string, GameInfo>();
  for (const g of games) {
    map.set(g.contractAddress.toLowerCase(), {
      name: g.name,
      imageUrl: g.imageUrl,
      clientUrl: g.clientUrl,
    });
  }
  return map;
}

/** Look up a game by contract address. Used by /enter and /tournament displays. */
export async function findGame(chain: Chain, contractAddress: string): Promise<Game | undefined> {
  const target = contractAddress.toLowerCase();
  const list = await gamesForChain(chain);
  return list.find((g) => g.contractAddress.toLowerCase() === target);
}

/**
 * Synchronous metadata-only lookup against the budokan-sdk whitelist.
 * Doesn't hit the indexer — for callers that already have a Game from the
 * picker but need static fields (e.g. game creator fee % at /create execute
 * time). Chain-scoped because the same game deploys at different addresses
 * per chain.
 */
export function gameMetadataFor(
  chain: Chain,
  contractAddress: string,
): WhitelistedGame | undefined {
  return findWhitelistedGame(chain, contractAddress);
}

// Cache of the registry-required game fee (bps) per chain:game. The minimum is
// fixed on-chain, so one lookup per game is plenty.
const gameFeeBpsCache = new Map<string, number>();

/**
 * The game's required creator fee in basis points, read live from the registry
 * (game → token → registry → game_fee_info). Budokan's `_assert_game_fee_met`
 * rejects a `game_creator_share` below this, so /create uses it as the floor.
 * Returns null on any read failure — callers fall back to the catalog default.
 *
 * The on-chain `GameFeeInfo` ends with the fee numerator (bps); a licence
 * ByteArray sits before it, so we read the LAST felt of the response.
 */
export async function fetchGameFeeBps(
  chain: Chain,
  gameAddress: string,
  rpcUrl?: string,
): Promise<number | null> {
  const key = `${chain}:${gameAddress.toLowerCase()}`;
  const cached = gameFeeBpsCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const rpc = new RpcProvider({ nodeUrl: rpcUrl ?? CHAINS[chain]?.rpcUrl });
    const call = (addr: string, fn: string, cd: string[] = []) =>
      rpc.callContract({ contractAddress: addr, entrypoint: fn, calldata: cd });
    const tokenAddress = (await call(gameAddress, "token_address"))[0]!;
    const registry = (await call(tokenAddress, "game_registry_address"))[0]!;
    const gameId = (await call(registry, "game_id_from_address", [gameAddress]))[0]!;
    const info = await call(registry, "game_fee_info", [gameId]);
    const bps = Number(BigInt(info[info.length - 1]!));
    if (!Number.isFinite(bps) || bps < 0 || bps > 10000) return null;
    gameFeeBpsCache.set(key, bps);
    return bps;
  } catch {
    return null;
  }
}
