import type {
  ExtensionPrize as MetagameSdkExtensionPrize,
  Prize as MetagameSdkTokenPrize,
} from "@provable-games/metagame-sdk";
import type {
  ExtensionPrize,
  Prize,
  TokenPrize,
} from "../types/prize.js";

// Adapter output shapes intentionally track metagame-sdk@0.1.13. Review this
// module before changing the pinned metagame-sdk dependency.
export interface MetagameTokenPrize {
  id: string;
  position: number;
  tokenAddress: string;
  tokenType: "erc20" | "erc721";
  amount: string;
  sponsorAddress: string;
}

export interface MetagameExtensionPrize {
  id: string;
  position: number;
  tokenAddress: null;
  tokenType: "extension";
  amount: null;
  sponsorAddress: string;
  extensionAddress: string | null;
  extensionConfig: string[] | null;
}

export type MetagamePrizeLike = MetagameTokenPrize | MetagameExtensionPrize;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeIntegerString(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.trim() !== value) return false;

  try {
    return BigInt(value) >= 0n;
  } catch {
    return false;
  }
}

function hasBasePrizeFields(prize: Prize): boolean {
  return (
    isNonNegativeIntegerString(prize.prizeId) &&
    Number.isInteger(prize.payoutPosition) &&
    isNonEmptyString(prize.sponsorAddress)
  );
}

function hasHydratedTokenPosition(prize: Prize): boolean {
  return prize.payoutPosition > 0;
}

function hasNonNegativePayoutPosition(prize: Prize): boolean {
  return prize.payoutPosition >= 0;
}

function hasExtensionConfig(value: unknown): boolean {
  return (
    value === null ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function describePrize(prize: Prize): string {
  const prizeId = isNonEmptyString(prize.prizeId) ? prize.prizeId : "<invalid>";
  return `prizeId=${prizeId}, tokenType=${prize.tokenType}`;
}

function malformedTokenPrizeError(
  action: "adapt" | "read",
  prize: Prize,
): TypeError {
  return new TypeError(
    `Cannot ${action} malformed Budokan token prize (${describePrize(prize)})`,
  );
}

function assertMetagameTokenPosition(prize: TokenPrize): void {
  if (prize.payoutPosition > 0) return;

  throw new TypeError(
    `Cannot adapt Budokan token prize with unhydrated payout position (${
      describePrize(prize)
    })`,
  );
}

export function isTokenPrize(prize: Prize): prize is TokenPrize {
  if (
    !hasBasePrizeFields(prize) ||
    !hasHydratedTokenPosition(prize) ||
    !isNonEmptyString(prize.tokenAddress)
  ) {
    return false;
  }

  return prize.tokenType === "erc20"
    ? isNonNegativeIntegerString(prize.amount) &&
        prize.tokenId === null &&
        prize.extensionAddress === null &&
        prize.extensionConfig === null
    : prize.tokenType === "erc721" &&
        prize.amount === null &&
        isNonNegativeIntegerString(prize.tokenId) &&
        prize.extensionAddress === null &&
        prize.extensionConfig === null;
}

export function isExtensionPrize(prize: Prize): prize is ExtensionPrize {
  return (
    hasBasePrizeFields(prize) &&
    hasNonNegativePayoutPosition(prize) &&
    prize.tokenType === "extension" &&
    prize.tokenAddress === null &&
    prize.amount === null &&
    prize.tokenId === null &&
    isNonEmptyString(prize.extensionAddress) &&
    hasExtensionConfig(prize.extensionConfig)
  );
}

/**
 * Returns validated token prizes. Extension prizes are skipped; malformed
 * `erc20`/`erc721` records throw instead of being silently dropped.
 */
export function getTokenPrizes(prizes: readonly Prize[]): TokenPrize[] {
  return prizes.flatMap((prize) => {
    if (isTokenPrize(prize)) return [prize];
    if (prize.tokenType === "extension") return [];

    throw malformedTokenPrizeError("read", prize);
  });
}

/**
 * Converts a guard-validated Budokan token prize into the Metagame SDK token
 * prize shape. Metagame token prizes do not carry Budokan distribution fields,
 * so distributed ERC20 prizes are represented by their aggregate `amount` at
 * `payoutPosition`; use the original Budokan `Prize` for payout-split math.
 * Throws when `payoutPosition` is zero because the RPC path uses zero for
 * unhydrated token-prize positions and metagame positions are leaderboard slots.
 */
export function toMetagameTokenPrize(
  prize: TokenPrize,
): MetagameTokenPrize {
  assertMetagameTokenPosition(prize);

  const adapted = {
    id: prize.prizeId,
    position: prize.payoutPosition,
    tokenAddress: prize.tokenAddress,
    tokenType: prize.tokenType,
    // Metagame token prizes use `amount` as the token id for ERC721 entries.
    amount: prize.tokenType === "erc20" ? prize.amount : prize.tokenId,
    sponsorAddress: prize.sponsorAddress,
  } satisfies MetagameTokenPrize & MetagameSdkTokenPrize;

  return adapted;
}

/**
 * Converts a guard-validated Budokan extension prize into the Metagame SDK
 * extension-prize shape.
 */
export function toMetagameExtensionPrize(
  prize: ExtensionPrize,
): MetagameExtensionPrize {
  const adapted = {
    id: prize.prizeId,
    position: prize.payoutPosition,
    tokenAddress: null,
    tokenType: "extension",
    amount: null,
    sponsorAddress: prize.sponsorAddress,
    extensionAddress: prize.extensionAddress,
    extensionConfig: prize.extensionConfig,
  } satisfies MetagameExtensionPrize & MetagameSdkExtensionPrize;

  return adapted;
}

/**
 * Converts supported Budokan prize variants into Metagame SDK prize shapes.
 * Throws when a prize has a known Budokan token type but malformed fields.
 * See `toMetagameTokenPrize` for token prize distribution behavior.
 */
export function toMetagamePrize(
  prize: Prize,
): MetagamePrizeLike {
  if (isTokenPrize(prize)) return toMetagameTokenPrize(prize);
  if (isExtensionPrize(prize)) return toMetagameExtensionPrize(prize);

  throw new TypeError(
    `Cannot adapt malformed Budokan prize (${describePrize(prize)})`,
  );
}

/**
 * Converts supported Budokan prize variants into Metagame SDK prize shapes.
 * Throws when any prize has a known Budokan token type but malformed fields.
 * See `toMetagameTokenPrize` for token prize distribution behavior.
 */
export function toMetagamePrizes(
  prizes: readonly Prize[],
): MetagamePrizeLike[] {
  return prizes.map(toMetagamePrize);
}

/**
 * Converts Budokan token prizes into Metagame SDK token prize shapes.
 * See `toMetagameTokenPrize` for distribution behavior.
 */
export function toMetagameTokenPrizes(
  prizes: readonly Prize[],
): MetagameTokenPrize[] {
  return prizes.flatMap((prize) => {
    if (isTokenPrize(prize)) return [toMetagameTokenPrize(prize)];
    if (prize.tokenType === "extension") return [];

    throw malformedTokenPrizeError("adapt", prize);
  });
}
