// Per-chain game catalog. Source of truth is denshokan-sdk's game registry
// (DenshokanClient.getGames) — that's the same registry settings live in,
// so games and their settings are always consistent. We layer metadata
// on top (default fee token, controllerOnly flag) when the registered
// address matches a known game, but lookups never fail for missing
// metadata.
//
// MIGRATION NOTE: the metadata table below duplicates what
// `@provable-games/budokan-sdk` now exports as `getWhitelistedGames` /
// `findWhitelistedGame`. Once a budokan-sdk release with that export
// lands on npm and we bump the bot's dep, replace METADATA below with
// `findWhitelistedGame(chain, contractAddress)` so the data lives in
// exactly one place.
//
// The bot uses this for:
//   - /create's first picker (numbered list of registered games)
//   - displaying friendly names elsewhere

import { createDenshokanClient, type DenshokanClient } from "@provable-games/denshokan-sdk";
import { CHAINS } from "@provable-games/budokan-sdk";
import { RpcProvider } from "starknet";

import type { Chain } from "../chat-state.ts";

const STRK_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// Curated metadata keyed by lowercase contract address. Only fields that
// denshokan-sdk's Game doesn't carry. Lookup is a no-op miss when an
// address isn't here — we don't depend on it.
interface GameMetadata {
  defaultEntryFeeToken?: string;
  defaultGameFeePercentage?: number;
  controllerOnly?: boolean;
  /**
   * Score ordering for this game. `true` = lower-is-better (golf-style),
   * `false` (default) = higher-is-better (points-style). Used to skip the
   * "Lower scores win?" question in /create — most games are points-based
   * and the answer is a property of the game, not the tournament.
   */
  leaderboardAscending?: boolean;
  /**
   * Whether scores are only valid once the game has finished. Default false.
   * Same rationale: a property of the game, not a per-tournament choice.
   */
  leaderboardGameMustBeOver?: boolean;
}

const METADATA: Record<string, GameMetadata> = {
  // mainnet Death Mountain
  "0x4de0351ceab4ecd50be6ee09329b0dcb3b96a9da88cc158f453823a389722fa": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
    defaultGameFeePercentage: 5,
  },
  // mainnet zKube
  "0x642f228f70b1ca7edb4ab7ff0bab067369c2e276ddc2570ca18802d4e758edc": {
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  // sepolia Dark Shuffle
  "0x04359aee29873cd9603207d29b4140468bac3e042aa10daab2e1a8b2dd60ef7b": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  // sepolia Death Mountain
  "0x07ae26eecf0274aabb31677753ff3a4e15beec7268fa1b104f73ce3c89202831": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  // sepolia Nums
  "0x012ccc9a2d76c836d088203f6e9d62e22d1a9f7479d1aea8b503a1036c0f4487": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  // sepolia Number Guess (registry requires a 5% game fee)
  "0x3a2ea07f0f49c770035eed9a010eb3d1e1bc3cb92e1d47eef2ad75a25c6bdb2": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
    defaultGameFeePercentage: 5,
  },
  // sepolia zKube
  "0x5e02a1f750b3fa0e835d454705b664ecb23166cdb49459b1c96c1e3eaf9a2f4": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
};

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
 * List games for a chain. Same intersection the budokan client applies:
 * denshokan registry ∩ whitelist. A game must be both:
 *   1. Registered with denshokan (so settings are queryable), AND
 *   2. On our whitelist (so we have UX metadata + know we support it)
 *
 * Returns an empty array on indexer failure (caller should treat as
 * "no games"). Sorted by name for stable numbering across reloads.
 */
export async function gamesForChain(chain: Chain): Promise<Game[]> {
  let result;
  try {
    result = await getClient(chain).getGames({ limit: 100 });
  } catch {
    return [];
  }
  const games: Game[] = [];
  for (const g of result.data) {
    const meta = METADATA[g.contractAddress.toLowerCase()];
    if (!meta) continue; // Not whitelisted → hide from the picker.
    games.push({
      contractAddress: g.contractAddress,
      name: g.name,
      description: g.description,
      imageUrl: g.imageUrl,
      clientUrl: g.clientUrl,
      ...meta,
    });
  }
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
 * Synchronous metadata-only lookup. Returns the static metadata block from
 * the whitelist (defaultEntryFeeToken, defaultGameFeePercentage,
 * controllerOnly). Doesn't hit the indexer — for callers that already have
 * a Game from the picker but need metadata fields outside the registry
 * shape (e.g. game creator fee % at /create execute time).
 */
export function gameMetadataFor(contractAddress: string): GameMetadata | undefined {
  return METADATA[contractAddress.toLowerCase()];
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
