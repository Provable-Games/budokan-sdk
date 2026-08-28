/**
 * Whitelisted games and per-game metadata.
 *
 * Under Budokan v2 this list is the AUTHORITY, not an overlay. v2 removed the
 * on-chain minigame registry, so there is nothing to enumerate: being listed
 * here is the only way a host can select a game.
 *
 * A denshokan indexer may still carry a v2 game, and is worth reading for a
 * name and artwork — but only the V2 indexer. A v1 indexer serves
 * registry-era games that v2's `create_tournament` rejects, so intersecting
 * this list with one selects exactly the games that cannot be used. Enrich
 * from the indexer; never let it decide what is offered.
 *
 * Only games that can actually host a v2 tournament are listed — an entry
 * that would revert at create_tournament is removed, not flagged, so no
 * consumer needs filtering logic to be correct. Verify with
 * budokan/contracts/scripts/check_game_compatible.sh before adding any
 * entry — it mirrors the contract's acceptance checks exactly. `disabled`
 * remains available for temporarily pulling a listed game (e.g. an incident)
 * without deleting its metadata; consumers offering games for selection
 * still filter it.
 *
 * Lifted out of the budokan client (formerly
 * `client/src/assets/games/index.tsx`) so other integrations — the
 * Telegram bot in `examples/telegram-controller-bot/`, third-party
 * consumers — can use the same list without copy-pasting.
 *
 * Addresses are stored in canonical normalized form (0x-prefixed,
 * 66 chars, lowercase). Lookups normalize their input.
 */
import { normalizeAddress } from "../utils/address.js";
import type { ChainConfig } from "../chains/constants.js";

/** Subset of chain identifiers the whitelist covers. */
export type WhitelistChain = "mainnet" | "sepolia";

export interface WhitelistedGame {
  /** Canonical 0x-prefixed, 66-char lowercase contract address. */
  contractAddress: string;
  /** Display name. */
  name: string;
  /** Optional remote logo URL. The SDK never bundles binary assets — host externally. */
  imageUrl?: string;
  /** Game's homepage / landing URL. */
  url?: string;
  /** Direct-play URL template. May include `{tokenId}`. */
  playUrl?: string;
  /** Optional spectator URLs. */
  watchLink?: string;
  replayLink?: string;
  /** True if the game requires a Cartridge Controller to play. */
  controllerOnly?: boolean;
  /** Hide from default listings while keeping the metadata around. */
  disabled?: boolean;
  /** Minimum entry fee floor in USD, used as a UX hint at tournament-create time. */
  minEntryFeeUsd?: number;
  /** Recommended ERC-20 token for entry fee on this chain. */
  defaultEntryFeeToken?: string;
  /** Game-creator share of entry fee (basis-points-style — `5` means 5%). */
  defaultGameFeePercentage?: number;
  /** Approximate gas cost per entry, in USD — UX hint only. */
  averageGasCostUsd?: number;
  /** Some game tokens use animated SVG that needs `<object>` rather than `<img>`. */
  objectImage?: boolean;
  /**
   * Score ordering. `true` = lower-is-better (golf-style), `false` = higher-
   * is-better (points-style). Defaults to false when omitted — most games
   * are points-based.
   */
  leaderboardAscending?: boolean;
  /**
   * Whether the game's score is only valid once the game is in a completed
   * (e.g. dead, finished) state. Tournament-creation UIs hide this question
   * when the property of the game is known. Defaults to false.
   */
  leaderboardGameMustBeOver?: boolean;
}

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// EMPTY on purpose: no mainnet game passes v2 acceptance yet. The v1-era
// entries that used to live here (Death Mountain 0x4de0351c…, zKube
// 0x642f228f…) point their token_address() at denshokan, so v2's
// create_tournament rejects them — and this SDK line is the v2 line; v1
// consumers stay pinned to 0.1.x, which still carries them. The first
// self-bound build to pass check_game_compatible.sh on mainnet gets added
// here, in the same release that repoints CHAINS.mainnet at the v2 Budokan.
const MAINNET_GAMES_RAW: readonly WhitelistedGame[] = [
];

const SEPOLIA_GAMES_RAW: readonly WhitelistedGame[] = [
  {
    // The first v2-compatible game: self-bound standard token, built against
    // the game-components revision Budokan v2 is pinned to. Passes all four
    // gate checks in check_game_compatible.sh. The 5% fee matches the 500 bps
    // floor the token declares on-chain — Budokan enforces that as a floor,
    // so a lower share reverts.
    contractAddress: "0x016fa4b7263337504a37add061ee809b13c1de3477d7be2211447db3a77fea69",
    name: "Death Mountain (v2)",
    url: "https://deathmountain.gg/",
    playUrl: "https://deathmountain.gg/play?id=",
    watchLink: "https://deathmountain.gg/watch?id=",
    replayLink: "https://deathmountain.gg/replay?id=",
    controllerOnly: true,
    minEntryFeeUsd: 0.25,
    defaultEntryFeeToken: STRK,
    defaultGameFeePercentage: 5,
  },
];

// Normalize once at module load — addresses in the source list above are
// inconsistently padded; storing canonical form simplifies lookups.
const MAINNET_GAMES: readonly WhitelistedGame[] = MAINNET_GAMES_RAW.map(canonicalize);
const SEPOLIA_GAMES: readonly WhitelistedGame[] = SEPOLIA_GAMES_RAW.map(canonicalize);

function canonicalize(game: WhitelistedGame): WhitelistedGame {
  return {
    ...game,
    contractAddress: normalizeAddress(game.contractAddress),
    defaultEntryFeeToken: game.defaultEntryFeeToken
      ? normalizeAddress(game.defaultEntryFeeToken)
      : undefined,
  };
}

/**
 * Whitelisted games for a chain, sorted by name with disabled entries last.
 *
 * Returns a frozen copy — mutations don't bleed back into the module state.
 */
export function getWhitelistedGames(chain: WhitelistChain): WhitelistedGame[] {
  const list = chain === "mainnet" ? MAINNET_GAMES : SEPOLIA_GAMES;
  // Clone the objects, not just the array, so a caller mutating a returned
  // game can't corrupt the module's canonical entries (and future lookups).
  return list.map((g) => ({ ...g })).sort((a, b) => {
    const aDisabled = a.disabled ?? false;
    const bDisabled = b.disabled ?? false;
    if (aDisabled !== bDisabled) return aDisabled ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Look up a single whitelisted game by contract address. Address is normalized
 * before comparison so callers can pass any padding.
 */
export function findWhitelistedGame(
  chain: WhitelistChain,
  contractAddress: string,
): WhitelistedGame | undefined {
  // Lookups are not validation points: unparseable input is simply not on
  // the whitelist (getGameDefaults then serves its documented fallbacks).
  let target: string;
  try {
    target = normalizeAddress(contractAddress);
  } catch {
    return undefined;
  }
  return getWhitelistedGames(chain).find((g) => g.contractAddress === target);
}

/** True if the given game is on the whitelist. */
export function isGameWhitelisted(chain: WhitelistChain, contractAddress: string): boolean {
  return findWhitelistedGame(chain, contractAddress) !== undefined;
}

/**
 * Direct play link for a game token — the URL where the player actually plays
 * their run, not the Budokan tournament page. Built from the whitelist's
 * `playUrl` template: either `…{tokenId}…` (substituted) or a prefix the token
 * id is appended to (e.g. `…/play?id=`). Returns `undefined` when the game
 * isn't whitelisted or has no `playUrl` — callers should fall back to the
 * tournament page. Extend the list in this file to add a game (community-
 * maintained).
 */
export function buildPlayUrl(
  chain: WhitelistChain,
  contractAddress: string,
  tokenId: string | number | bigint,
): string | undefined {
  const game = findWhitelistedGame(chain, contractAddress);
  if (!game?.playUrl) return undefined;
  const id = String(tokenId);
  return game.playUrl.includes("{tokenId}")
    ? game.playUrl.replace(/\{tokenId\}/g, id)
    : `${game.playUrl}${id}`;
}

/**
 * Defaults block — what UI surfaces should pre-fill when the user picks this
 * game. Falls back to per-chain sensible defaults (STRK as fee token, 1% fee,
 * $0.25 minimum) when the game isn't whitelisted, so callers don't have to
 * special-case missing entries.
 */
export interface GameDefaults {
  minEntryFeeUsd: number;
  defaultEntryFeeToken: string;
  defaultGameFeePercentage: number;
  averageGasCostUsd: number | undefined;
  /** Inherited leaderboard ordering (true = lower wins, false = higher wins). */
  leaderboardAscending: boolean;
  /** Inherited "must finish game before submitting" flag. */
  leaderboardGameMustBeOver: boolean;
}

export function getGameDefaults(
  chain: WhitelistChain,
  contractAddress: string,
): GameDefaults {
  const game = findWhitelistedGame(chain, contractAddress);
  return {
    minEntryFeeUsd: game?.minEntryFeeUsd ?? 0.25,
    defaultEntryFeeToken: game?.defaultEntryFeeToken ?? STRK,
    defaultGameFeePercentage: game?.defaultGameFeePercentage ?? 1,
    averageGasCostUsd: game?.averageGasCostUsd,
    leaderboardAscending: game?.leaderboardAscending ?? false,
    leaderboardGameMustBeOver: game?.leaderboardGameMustBeOver ?? false,
  };
}

// Re-export so consumers don't have to reach into chains/.
export type { ChainConfig };
