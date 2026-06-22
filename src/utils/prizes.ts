import type {
  ExtensionPrize as MetagameExtensionPrize,
  Prize as MetagameTokenPrize,
  PrizeLike as MetagamePrizeLike,
} from "@provable-games/metagame-sdk";
import type {
  ExtensionPrize,
  Prize,
  TokenPrize,
} from "../types/prize.js";

export type { MetagameExtensionPrize, MetagamePrizeLike, MetagameTokenPrize };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasBasePrizeFields(prize: Prize): boolean {
  return (
    isNonEmptyString(prize.prizeId) &&
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

export function isTokenPrize(prize: Prize): prize is TokenPrize {
  if (
    !hasBasePrizeFields(prize) ||
    prize.payoutPosition <= 0 ||
    !isNonEmptyString(prize.tokenAddress)
  ) {
    return false;
  }

  return prize.tokenType === "erc20"
    ? isNonEmptyString(prize.amount) &&
        prize.tokenId === null &&
        prize.extensionAddress === null &&
        prize.extensionConfig === null
    : prize.tokenType === "erc721" &&
        prize.amount === null &&
        isNonEmptyString(prize.tokenId) &&
        prize.extensionAddress === null &&
        prize.extensionConfig === null;
}

export function isExtensionPrize(prize: Prize): prize is ExtensionPrize {
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

export function getTokenPrizes(prizes: readonly Prize[]): TokenPrize[] {
  return prizes.filter(isTokenPrize);
}

export function toMetagameTokenPrize(
  prize: TokenPrize,
): MetagameTokenPrize {
  return {
    id: prize.prizeId,
    position: prize.payoutPosition,
    tokenAddress: prize.tokenAddress,
    tokenType: prize.tokenType,
    // Metagame token prizes use `amount` as the token id for ERC721 entries.
    amount: prize.tokenType === "erc20" ? prize.amount : prize.tokenId,
    sponsorAddress: prize.sponsorAddress,
  };
}

export function toMetagameExtensionPrize(
  prize: ExtensionPrize,
): MetagameExtensionPrize {
  return {
    id: prize.prizeId,
    position: prize.payoutPosition,
    tokenAddress: null,
    tokenType: "extension",
    amount: null,
    sponsorAddress: prize.sponsorAddress,
    extensionAddress: prize.extensionAddress,
    extensionConfig: prize.extensionConfig,
  };
}

export function toMetagamePrize(
  prize: Prize,
): MetagamePrizeLike | null {
  if (isTokenPrize(prize)) return toMetagameTokenPrize(prize);
  if (isExtensionPrize(prize)) return toMetagameExtensionPrize(prize);
  return null;
}

export function toMetagamePrizes(
  prizes: readonly Prize[],
): MetagamePrizeLike[] {
  return prizes.flatMap((prize) => {
    const adapted = toMetagamePrize(prize);
    return adapted ? [adapted] : [];
  });
}

export function toMetagameTokenPrizes(
  prizes: readonly Prize[],
): MetagameTokenPrize[] {
  return getTokenPrizes(prizes).map(toMetagameTokenPrize);
}
