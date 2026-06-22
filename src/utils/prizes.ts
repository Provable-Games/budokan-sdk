import type { Prize as MetagameTokenPrizeBase } from "@provable-games/metagame-sdk";
import type {
  ExtensionPrize,
  Prize,
  TokenPrize,
} from "../types/prize.js";

export type MetagameTokenPrize = MetagameTokenPrizeBase;

export type MetagameExtensionPrize = {
  id: string;
  position: number;
  tokenAddress: null;
  tokenType: "extension";
  amount: null;
  sponsorAddress: string;
  extensionAddress: string | null;
  extensionConfig: string[] | null;
};

export type MetagamePrizeLike = MetagameTokenPrize | MetagameExtensionPrize;

function hasExtensionConfig(value: string[] | null): value is string[] | null {
  return value === null || value.every((entry) => typeof entry === "string");
}

export function isTokenPrize(prize: Prize): prize is TokenPrize {
  if (typeof prize.tokenAddress !== "string" || prize.tokenAddress.length === 0) {
    return false;
  }

  return prize.tokenType === "erc20"
    ? typeof prize.amount === "string" &&
        prize.tokenId === null &&
        prize.extensionAddress === null &&
        prize.extensionConfig === null
    : prize.tokenType === "erc721" &&
        prize.amount === null &&
        typeof prize.tokenId === "string" &&
        prize.extensionAddress === null &&
        prize.extensionConfig === null;
}

export function isExtensionPrize(prize: Prize): prize is ExtensionPrize {
  return (
    prize.tokenType === "extension" &&
    prize.tokenAddress === null &&
    prize.amount === null &&
    prize.tokenId === null &&
    typeof prize.extensionAddress === "string" &&
    prize.extensionAddress.length > 0 &&
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
