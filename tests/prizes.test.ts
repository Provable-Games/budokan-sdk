import { describe, expect, test } from "bun:test";
import {
  getTokenPrizes,
  isExtensionPrize,
  isTokenPrize,
  toMetagamePrize,
  toMetagamePrizes,
  toMetagameTokenPrize,
  toMetagameTokenPrizes,
} from "../src/utils/prizes.ts";
import type { Prize, TokenPrize } from "../src/types/prize.ts";

const erc20Prize: Prize = {
  prizeId: "1",
  tournamentId: "10",
  payoutPosition: 1,
  tokenAddress: "0xerc20",
  tokenType: "erc20",
  amount: "1000",
  tokenId: null,
  distributionType: null,
  distributionWeight: null,
  distributionShares: null,
  distributionCount: null,
  sponsorAddress: "0xsponsor",
  extensionAddress: null,
  extensionConfig: null,
};

const erc721Prize: Prize = {
  prizeId: "2",
  tournamentId: "10",
  payoutPosition: 2,
  tokenAddress: "0xnft",
  tokenType: "erc721",
  amount: null,
  tokenId: "77",
  distributionType: null,
  distributionWeight: null,
  distributionShares: null,
  distributionCount: null,
  sponsorAddress: "0xsponsor",
  extensionAddress: null,
  extensionConfig: null,
};

const extensionPrize: Prize = {
  prizeId: "3",
  tournamentId: "10",
  payoutPosition: 0,
  tokenAddress: null,
  tokenType: "extension",
  amount: null,
  tokenId: null,
  distributionType: null,
  distributionWeight: null,
  distributionShares: null,
  distributionCount: null,
  sponsorAddress: "0xsponsor",
  extensionAddress: "0xextension",
  extensionConfig: ["0x1", "0x2"],
};

function asTokenPrize(prize: Prize): TokenPrize {
  if (!isTokenPrize(prize)) {
    throw new Error(`Expected token prize ${prize.prizeId}`);
  }
  return prize;
}

describe("Budokan prize helpers", () => {
  test("identifies token and extension prizes", () => {
    expect(isTokenPrize(erc20Prize)).toBe(true);
    expect(isTokenPrize(erc721Prize)).toBe(true);
    expect(isTokenPrize(extensionPrize)).toBe(false);
    expect(isExtensionPrize(extensionPrize)).toBe(true);
  });

  test("rejects malformed prize refinements", () => {
    expect(isTokenPrize({ ...erc20Prize, tokenId: "unexpected" })).toBe(false);
    expect(isTokenPrize({ ...erc721Prize, amount: "unexpected" })).toBe(false);
    expect(isTokenPrize({ ...erc20Prize, extensionAddress: "0xextension" })).toBe(false);
    expect(isTokenPrize({ ...erc20Prize, prizeId: "" })).toBe(false);
    expect(isTokenPrize({ ...erc20Prize, prizeId: "not-a-number" })).toBe(false);
    expect(isTokenPrize({ ...erc20Prize, amount: "" })).toBe(false);
    expect(isTokenPrize({ ...erc20Prize, amount: "not-a-number" })).toBe(false);
    expect(isTokenPrize({ ...erc721Prize, tokenId: "abc" })).toBe(false);
    expect(isExtensionPrize({ ...extensionPrize, extensionAddress: null })).toBe(false);
    expect(isExtensionPrize({ ...extensionPrize, tokenAddress: "0xtoken" })).toBe(false);
    expect(isExtensionPrize({ ...extensionPrize, extensionConfig: "0x1" as unknown as string[] })).toBe(false);
    expect(isExtensionPrize({ ...extensionPrize, prizeId: "" })).toBe(false);
    expect(isExtensionPrize({ ...extensionPrize, prizeId: "not-a-number" })).toBe(false);
    expect(isExtensionPrize({ ...extensionPrize, sponsorAddress: "" })).toBe(false);
  });

  test("accepts token prizes with unhydrated zero payout position", () => {
    expect(isTokenPrize({ ...erc20Prize, payoutPosition: 0 })).toBe(true);
    expect(toMetagameTokenPrize(asTokenPrize({ ...erc721Prize, payoutPosition: 0 }))).toEqual({
      id: "2",
      position: 0,
      tokenAddress: "0xnft",
      tokenType: "erc721",
      amount: "77",
      sponsorAddress: "0xsponsor",
    });
  });

  test("filters token prizes", () => {
    expect(getTokenPrizes([erc20Prize, extensionPrize, erc721Prize])).toEqual([
      erc20Prize,
      erc721Prize,
    ]);
  });

  test("converts token prizes to metagame token prizes", () => {
    expect(toMetagameTokenPrize(asTokenPrize(erc20Prize))).toEqual({
      id: "1",
      position: 1,
      tokenAddress: "0xerc20",
      tokenType: "erc20",
      amount: "1000",
      sponsorAddress: "0xsponsor",
    });

    expect(toMetagameTokenPrize(asTokenPrize(erc721Prize))).toEqual({
      id: "2",
      position: 2,
      tokenAddress: "0xnft",
      tokenType: "erc721",
      amount: "77",
      sponsorAddress: "0xsponsor",
    });
  });

  test("converts distributed token prizes as aggregate metagame amounts", () => {
    const distributedPrize = asTokenPrize({
      ...erc20Prize,
      payoutPosition: 0,
      distributionType: "linear",
      distributionWeight: 10,
      distributionCount: 3,
    });

    expect(toMetagameTokenPrize(distributedPrize)).toEqual({
      id: "1",
      position: 0,
      tokenAddress: "0xerc20",
      tokenType: "erc20",
      amount: "1000",
      sponsorAddress: "0xsponsor",
    });
  });

  test("converts extension prizes to metagame extension prizes", () => {
    expect(toMetagamePrize(extensionPrize)).toEqual({
      id: "3",
      position: 0,
      tokenAddress: null,
      tokenType: "extension",
      amount: null,
      sponsorAddress: "0xsponsor",
      extensionAddress: "0xextension",
      extensionConfig: ["0x1", "0x2"],
    });
  });

  test("converts mixed and token-only prize lists", () => {
    expect(toMetagamePrizes([erc20Prize, extensionPrize])).toHaveLength(2);
    expect(toMetagameTokenPrizes([erc20Prize, extensionPrize, erc721Prize])).toEqual([
      toMetagameTokenPrize(asTokenPrize(erc20Prize)),
      toMetagameTokenPrize(asTokenPrize(erc721Prize)),
    ]);
  });

  test("throws when adapting malformed prize records", () => {
    expect(() => toMetagamePrize({ ...erc20Prize, amount: "" })).toThrow(
      "Cannot adapt malformed Budokan prize (prizeId=1, tokenType=erc20)",
    );
    expect(() => toMetagamePrizes([erc20Prize, { ...erc20Prize, amount: "" }])).toThrow(
      "Cannot adapt malformed Budokan prize (prizeId=1, tokenType=erc20)",
    );
    expect(() => toMetagameTokenPrizes([{ ...erc721Prize, tokenId: "abc" }])).toThrow(
      "Cannot adapt malformed Budokan token prize (prizeId=2, tokenType=erc721)",
    );
  });
});
