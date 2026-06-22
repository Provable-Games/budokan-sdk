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

export function isTokenPrize(prize: Prize): prize is TokenPrize {
  if (
    (prize.tokenType !== "erc20" && prize.tokenType !== "erc721") ||
    typeof prize.tokenAddress !== "string" ||
    prize.tokenAddress.length === 0
  ) {
    return false;
  }

  return prize.tokenType === "erc20"
    ? typeof prize.amount === "string"
    : typeof prize.tokenId === "string";
}

export function isExtensionPrize(prize: Prize): prize is ExtensionPrize {
  return prize.tokenType === "extension";
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
