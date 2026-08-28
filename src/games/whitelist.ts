/**
 * Whitelisted games and per-game metadata.
 *
 * Under Budokan v2 this list is the AUTHORITY, not an overlay: v2 removed the
 * on-chain minigame registry, and a v2 game never registers with denshokan.
 * Registry presence therefore does not mean a game exists in any useful sense
 * — it means the game is v1-era, and v2's `create_tournament` rejects it.
 * Do not intersect this list with the registry; that selects exactly the
 * games that cannot be used and drops the ones that can.
 *
 * `disabled: true` marks an entry that is listed for reference but cannot
 * host a v2 tournament yet. Every consumer that offers games for selection
 * must filter it out. Verify with
 * budokan/contracts/scripts/check_game_compatible.sh before clearing the
 * flag on any entry — it mirrors the contract's acceptance checks exactly.
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

// Both mainnet entries are v1-era (their token_address() points at denshokan,
// so v2 rejects them). They stay ENABLED because the SDK's mainnet chain
// config still points at the v1 Budokan, where they work. They must be
// disabled or replaced with self-bound builds IN THE SAME RELEASE as the
// mainnet budokanAddress repoint — against the v2 contract every one of them
// reverts at create_tournament.
const MAINNET_GAMES_RAW: readonly WhitelistedGame[] = [
  {
    contractAddress: "0x4de0351ceab4ecd50be6ee09329b0dcb3b96a9da88cc158f453823a389722fa",
    name: "Death Mountain",
    url: "https://deathmountain.gg/",
    playUrl: "https://deathmountain.gg/play?id=",
    watchLink: "https://deathmountain.gg/watch?id=",
    replayLink: "https://deathmountain.gg/replay?id=",
    controllerOnly: true,
    minEntryFeeUsd: 0.25,
    defaultEntryFeeToken: STRK,
    defaultGameFeePercentage: 5,
    averageGasCostUsd: 0.25,
  },
  {
    contractAddress: "0x642f228f70b1ca7edb4ab7ff0bab067369c2e276ddc2570ca18802d4e758edc",
    name: "zKube",
    imageUrl: "https://zkube-budokan-sepolia.vercel.app/assets/logo.png",
    url: "https://zkube.io",
    playUrl: "https://zkube.io/play/",
    minEntryFeeUsd: 0.25,
    defaultEntryFeeToken: STRK,
  },
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
  {
    contractAddress: "0x04359aee29873cd9603207d29b4140468bac3e042aa10daab2e1a8b2dd60ef7b",
    name: "Dark Shuffle",
    imageUrl: "https://darkshuffle.dev/favicon.svg",
    url: "https://darkshuffle.dev",
    controllerOnly: true,
    minEntryFeeUsd: 0.25,
    defaultEntryFeeToken: STRK,
    // Not v2-compatible: token_address() points at a separate contract,
    // so create_tournament reverts.
    disabled: true,
  },
  {
    contractAddress: "0x07ae26eecf0274aabb31677753ff3a4e15beec7268fa1b104f73ce3c89202831",
    name: "Death Mountain",
    imageUrl: "https://darkshuffle.dev/favicon.svg",
    url: "https://lootsurvivor.io/",
    playUrl: "https://lootsurvivor.io/survivor/play?id=",
    controllerOnly: true,
    minEntryFeeUsd: 0.25,
    defaultEntryFeeToken: STRK,
    // Not v2-compatible: token_address() points at a separate contract,
    // so create_tournament reverts.
    disabled: true,
  },
  {
    contractAddress: "0x012ccc9a2d76c836d088203f6e9d62e22d1a9f7479d1aea8b503a1036c0f4487",
    name: "Nums",
    url: "https://nums-blond.vercel.app/",
    playUrl: "https://nums-blond.vercel.app/",
    controllerOnly: true,
    minEntryFeeUsd: 0.25,
    defaultEntryFeeToken: STRK,
    // Not v2-compatible: token_address() points at a separate contract,
    // so create_tournament reverts.
    disabled: true,
  },
  {
    contractAddress: "0x3a2ea07f0f49c770035eed9a010eb3d1e1bc3cb92e1d47eef2ad75a25c6bdb2",
    name: "Number Guess",
    url: "https://funfactory.gg/games/1",
    playUrl: "https://funfactory.gg/tokens/{tokenId}/play",
    controllerOnly: true,
    minEntryFeeUsd: 0.25,
    defaultEntryFeeToken: STRK,
    objectImage: true,
    // Not v2-compatible: token_address() points at a separate contract,
    // so create_tournament reverts.
    disabled: true,
  },
  {
    contractAddress: "0x5e02a1f750b3fa0e835d454705b664ecb23166cdb49459b1c96c1e3eaf9a2f4",
    name: "zKube",
    imageUrl: "https://zkube-budokan-sepolia.vercel.app/assets/logo.png",
    url: "https://zkube-budokan-sepolia.vercel.app",
    playUrl: "https://zkube-budokan-sepolia.vercel.app/play/",
    controllerOnly: true,
    minEntryFeeUsd: 0.25,
    defaultEntryFeeToken: STRK,
    // Not v2-compatible: token_address() points at a separate contract,
    // so create_tournament reverts.
    disabled: true,
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
