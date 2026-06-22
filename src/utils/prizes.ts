import type {
  ExtensionPrize as MetagameSdkExtensionPrize,
  Prize as MetagameSdkTokenPrize,
  PrizeLike as MetagameSdkPrizeLike,
} from "@provable-games/metagame-sdk";
import type {
  ExtensionPrize,
  Prize,
  TokenPrize,
} from "../types/prize.js";

// Adapter output types are derived from metagame-sdk@0.1.13. These exported
// aliases are part of Budokan's public API; changing the pinned metagame-sdk
// version needs a compatibility review.
export type MetagameTokenPrize = MetagameSdkTokenPrize;
export type MetagameExtensionPrize = MetagameSdkExtensionPrize;
export type MetagamePrizeLike = MetagameSdkPrizeLike;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeIntegerString(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.trim() !== value) return false;
  if (!/^\d+$/.test(value)) return false;

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
    prize.payoutPosition >= 0 &&
    isNonEmptyString(prize.sponsorAddress)
  );
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
  if (Number.isInteger(prize.payoutPosition) && prize.payoutPosition > 0) {
    return;
  }

  if (prize.payoutPosition !== 0) {
    throw new TypeError(
      `Cannot adapt Budokan token prize with invalid payout position (${
        describePrize(prize)
      })`,
    );
  }

  throw new TypeError(
    `Cannot adapt Budokan token prize with unhydrated payout position (${
      describePrize(prize)
    })`,
  );
}

function assertMetagameExtensionPosition(prize: ExtensionPrize): void {
  if (Number.isInteger(prize.payoutPosition) && prize.payoutPosition > 0) {
    return;
  }

  if (prize.payoutPosition !== 0) {
    throw new TypeError(
      `Cannot adapt Budokan extension prize with invalid payout position (${
        describePrize(prize)
      })`,
    );
  }

  throw new TypeError(
    `Cannot adapt Budokan extension prize with unhydrated payout position (${
      describePrize(prize)
    })`,
  );
}

function hasHydratedPayoutPosition(prize: Prize): boolean {
  return prize.payoutPosition > 0;
}

export function isRawTokenPrize(prize: Prize): prize is TokenPrize {
  if (
    !hasBasePrizeFields(prize) ||
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

export function isRawExtensionPrize(prize: Prize): prize is ExtensionPrize {
  return (
    hasBasePrizeFields(prize) &&
    prize.tokenType === "extension" &&
    prize.tokenAddress === null &&
    prize.amount === null &&
    prize.tokenId === null &&
    isNonEmptyString(prize.extensionAddress) &&
    hasExtensionConfig(prize.extensionConfig)
  );
}

export function isTokenPrize(prize: Prize): prize is TokenPrize {
  return isRawTokenPrize(prize) && hasHydratedPayoutPosition(prize);
}

export function isExtensionPrize(prize: Prize): prize is ExtensionPrize {
  return isRawExtensionPrize(prize) && hasHydratedPayoutPosition(prize);
}

/**
 * Returns true when a prize is a valid Budokan token/extension prize and has a
 * hydrated leaderboard position suitable for the metagame prize shape.
 */
export function isMetagameAdaptablePrize(
  prize: Prize,
): prize is TokenPrize | ExtensionPrize {
  return isTokenPrize(prize) || isExtensionPrize(prize);
}

/**
 * Returns validated raw token prizes. Extension records are skipped without
 * validation; malformed `erc20`/`erc721` records throw instead of being
 * silently dropped. RPC records with `payoutPosition === 0` are returned here
 * for raw token-prize visibility.
 */
export function getRawTokenPrizes(prizes: readonly Prize[]): TokenPrize[] {
  return prizes.flatMap((prize) => {
    if (isRawTokenPrize(prize)) return [prize];
    if (prize.tokenType === "extension") return [];

    throw malformedTokenPrizeError("read", prize);
  });
}

/**
 * Returns validated hydrated token prizes. Extension records are skipped
 * without validation, and valid raw token prizes with `payoutPosition === 0`
 * are skipped; malformed `erc20`/`erc721` records throw instead of being
 * silently dropped.
 */
export function getTokenPrizes(prizes: readonly Prize[]): TokenPrize[] {
  return prizes.flatMap((prize) => {
    if (isTokenPrize(prize)) return [prize];
    if (isRawTokenPrize(prize) || prize.tokenType === "extension") return [];

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
  } satisfies MetagameTokenPrize;

  return adapted;
}

/**
 * Converts a guard-validated Budokan extension prize into the Metagame SDK
 * extension-prize shape. Throws when `payoutPosition` is zero because metagame
 * positions are leaderboard slots and the RPC path uses zero for unhydrated
 * prize positions.
 */
export function toMetagameExtensionPrize(
  prize: ExtensionPrize,
): MetagameExtensionPrize {
  assertMetagameExtensionPosition(prize);

  const adapted = {
    id: prize.prizeId,
    position: prize.payoutPosition,
    tokenAddress: null,
    tokenType: "extension",
    amount: null,
    sponsorAddress: prize.sponsorAddress,
    extensionAddress: prize.extensionAddress,
    extensionConfig: prize.extensionConfig,
  } satisfies MetagameExtensionPrize;

  return adapted;
}

/**
 * Converts supported Budokan prize variants into Metagame SDK prize shapes.
 * Throws when a prize has malformed fields or an unhydrated payout position.
 * Raw-but-valid zero-position prizes throw the unhydrated-position error.
 * See `toMetagameTokenPrize` for token prize distribution behavior.
 */
export function toMetagamePrize(
  prize: Prize,
): MetagamePrizeLike {
  if (isRawTokenPrize(prize)) return toMetagameTokenPrize(prize);
  if (isRawExtensionPrize(prize)) return toMetagameExtensionPrize(prize);

  throw new TypeError(
    `Cannot adapt malformed Budokan prize (${describePrize(prize)})`,
  );
}

/**
 * Non-throwing metagame adapter. Returns null for malformed prize records and
 * for valid RPC-sourced prizes whose `payoutPosition` is not hydrated yet.
 */
export function tryToMetagamePrize(
  prize: Prize,
): MetagamePrizeLike | null {
  if (!isMetagameAdaptablePrize(prize)) return null;
  return prize.tokenType === "extension"
    ? toMetagameExtensionPrize(prize)
    : toMetagameTokenPrize(prize);
}

/**
 * Converts supported Budokan prize variants into Metagame SDK prize shapes.
 * Throws when any prize has malformed fields or an unhydrated payout position.
 * See `toMetagameTokenPrize` for token prize distribution behavior.
 */
export function toMetagamePrizes(
  prizes: readonly Prize[],
): MetagamePrizeLike[] {
  return prizes.map(toMetagamePrize);
}

/**
 * Non-throwing batch metagame adapter. Skips malformed records and valid
 * RPC-sourced prizes whose `payoutPosition` is not hydrated yet.
 */
export function tryToMetagamePrizes(
  prizes: readonly Prize[],
): MetagamePrizeLike[] {
  return prizes.flatMap((prize) => {
    const adapted = tryToMetagamePrize(prize);
    return adapted ? [adapted] : [];
  });
}

/**
 * Converts Budokan token prizes into Metagame SDK token prize shapes. Extension
 * records are skipped without validation. Throws for malformed token records
 * and unhydrated token positions. See `toMetagameTokenPrize` for distribution
 * behavior.
 */
export function toMetagameTokenPrizes(
  prizes: readonly Prize[],
): MetagameTokenPrize[] {
  return prizes.flatMap((prize) => {
    if (isRawTokenPrize(prize)) return [toMetagameTokenPrize(prize)];
    if (prize.tokenType === "extension") return [];

    throw malformedTokenPrizeError("adapt", prize);
  });
}
