import { describe, expect, test } from "bun:test";
import {
  getRawTokenPrizes,
  getTokenPrizes,
  isExtensionPrize,
  isMetagameAdaptablePrize,
  isRawExtensionPrize,
  isRawTokenPrize,
  isTokenPrize,
  toMetagameExtensionPrize,
  toMetagamePrize,
  toMetagamePrizes,
  toMetagameTokenPrize,
  toMetagameTokenPrizes,
  tryToMetagamePrize,
  tryToMetagamePrizes,
} from "../src/utils/prizes.ts";
import type { ExtensionPrize, Prize, TokenPrize } from "../src/types/prize.ts";

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

const hydratedExtensionPrize: Prize = {
  ...extensionPrize,
  payoutPosition: 3,
};

function asTokenPrize(prize: Prize): TokenPrize {
  if (!isRawTokenPrize(prize)) {
    throw new Error(`Expected token prize ${prize.prizeId}`);
  }
  return prize;
}

describe("Budokan prize helpers", () => {
  test("identifies token and extension prizes", () => {
    expect(isTokenPrize(erc20Prize)).toBe(true);
    expect(isTokenPrize(erc721Prize)).toBe(true);
    expect(isTokenPrize(extensionPrize)).toBe(false);
    expect(isRawTokenPrize(erc20Prize)).toBe(true);
    expect(isRawTokenPrize(erc721Prize)).toBe(true);
    expect(isRawExtensionPrize(extensionPrize)).toBe(true);
    expect(isExtensionPrize(extensionPrize)).toBe(false);
    expect(isExtensionPrize(hydratedExtensionPrize)).toBe(true);
  });

  test("rejects malformed prize refinements", () => {
    expect(isTokenPrize({ ...erc20Prize, tokenId: "unexpected" })).toBe(false);
    expect(isTokenPrize({ ...erc721Prize, amount: "unexpected" })).toBe(false);
    expect(isTokenPrize({ ...erc20Prize, extensionAddress: "0xextension" })).toBe(
      false,
    );
    expect(isTokenPrize({ ...erc20Prize, prizeId: "" })).toBe(false);
    expect(isTokenPrize({ ...erc20Prize, prizeId: "not-a-number" })).toBe(
      false,
    );
    expect(isTokenPrize({ ...erc20Prize, prizeId: "0x1" })).toBe(false);
    expect(isTokenPrize({ ...erc20Prize, amount: "" })).toBe(false);
    expect(isTokenPrize({ ...erc20Prize, amount: "not-a-number" })).toBe(
      false,
    );
    expect(isTokenPrize({ ...erc20Prize, amount: "0x3e8" })).toBe(false);
    expect(isTokenPrize({ ...erc721Prize, tokenId: "abc" })).toBe(false);
    expect(isTokenPrize({ ...erc721Prize, tokenId: "0x4d" })).toBe(false);
    expect(isRawExtensionPrize({ ...extensionPrize, extensionAddress: null }))
      .toBe(false);
    expect(isExtensionPrize({ ...hydratedExtensionPrize, extensionAddress: null }))
      .toBe(false);
    expect(isRawExtensionPrize({ ...extensionPrize, tokenAddress: "0xtoken" }))
      .toBe(false);
    expect(isRawExtensionPrize({
      ...extensionPrize,
      extensionConfig: "0x1" as unknown as string[],
    })).toBe(false);
    expect(isRawExtensionPrize({ ...extensionPrize, prizeId: "" })).toBe(false);
    expect(isRawExtensionPrize({ ...extensionPrize, prizeId: "not-a-number" }))
      .toBe(false);
    expect(isRawExtensionPrize({ ...extensionPrize, prizeId: "0x3" }))
      .toBe(false);
    expect(isRawExtensionPrize({ ...extensionPrize, sponsorAddress: "" }))
      .toBe(false);
  });

  test("keeps raw helpers available for unhydrated zero payout positions", () => {
    expect(isRawTokenPrize({ ...erc20Prize, payoutPosition: 0 })).toBe(true);
    expect(isTokenPrize({ ...erc20Prize, payoutPosition: 0 })).toBe(false);
    expect(getRawTokenPrizes([{ ...erc721Prize, payoutPosition: 0 }]))
      .toHaveLength(1);
    expect(getTokenPrizes([{ ...erc721Prize, payoutPosition: 0 }])).toEqual([]);
  });

  test("identifies metagame-adaptable prizes", () => {
    expect(isMetagameAdaptablePrize(erc20Prize)).toBe(true);
    expect(isMetagameAdaptablePrize(hydratedExtensionPrize)).toBe(true);
    expect(isMetagameAdaptablePrize({ ...erc20Prize, payoutPosition: 0 })).toBe(
      false,
    );
    expect(isMetagameAdaptablePrize(extensionPrize)).toBe(false);
    expect(isMetagameAdaptablePrize({ ...erc20Prize, amount: "" })).toBe(false);
  });

  test("rejects unhydrated zero payout positions when adapting prizes", () => {
    expect(() =>
      toMetagameTokenPrize({ ...erc721Prize, payoutPosition: 0 } as TokenPrize),
    ).toThrow(
      "Cannot adapt Budokan token prize with unhydrated payout position (prizeId=2, tokenType=erc721)",
    );
    expect(() =>
      toMetagameTokenPrizes([{ ...erc721Prize, payoutPosition: 0 }]),
    ).toThrow(
      "Cannot adapt Budokan token prize with unhydrated payout position (prizeId=2, tokenType=erc721)",
    );
    expect(() => toMetagamePrize(extensionPrize)).toThrow(
      "Cannot adapt Budokan extension prize with unhydrated payout position (prizeId=3, tokenType=extension)",
    );
    expect(() => toMetagamePrizes([erc20Prize, extensionPrize])).toThrow(
      "Cannot adapt Budokan extension prize with unhydrated payout position (prizeId=3, tokenType=extension)",
    );
  });

  test("rejects non-integer payout positions in direct adapters", () => {
    expect(() =>
      toMetagameTokenPrize({ ...erc20Prize, payoutPosition: 1.5 } as TokenPrize),
    ).toThrow(
      "Cannot adapt Budokan token prize with invalid payout position (prizeId=1, tokenType=erc20)",
    );
    expect(() =>
      toMetagameExtensionPrize({
        ...hydratedExtensionPrize,
        payoutPosition: 2.5,
      } as ExtensionPrize),
    ).toThrow(
      "Cannot adapt Budokan extension prize with invalid payout position (prizeId=3, tokenType=extension)",
    );
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
      payoutPosition: 1,
      distributionType: "linear",
      distributionWeight: 10,
      distributionCount: 3,
    });

    expect(toMetagameTokenPrize(distributedPrize)).toEqual({
      id: "1",
      position: 1,
      tokenAddress: "0xerc20",
      tokenType: "erc20",
      amount: "1000",
      sponsorAddress: "0xsponsor",
    });
  });

  test("converts extension prizes to metagame extension prizes", () => {
    expect(toMetagamePrize(hydratedExtensionPrize)).toEqual({
      id: "3",
      position: 3,
      tokenAddress: null,
      tokenType: "extension",
      amount: null,
      sponsorAddress: "0xsponsor",
      extensionAddress: "0xextension",
      extensionConfig: ["0x1", "0x2"],
    });
  });

  test("converts mixed and token-only prize lists", () => {
    expect(toMetagamePrizes([erc20Prize, hydratedExtensionPrize])).toHaveLength(
      2,
    );
    expect(
      toMetagameTokenPrizes([erc20Prize, extensionPrize, erc721Prize]),
    ).toEqual([
      toMetagameTokenPrize(asTokenPrize(erc20Prize)),
      toMetagameTokenPrize(asTokenPrize(erc721Prize)),
    ]);
  });

  test("try adapters skip malformed and unhydrated prize records", () => {
    expect(tryToMetagamePrize(extensionPrize)).toBeNull();
    expect(tryToMetagamePrize({ ...erc20Prize, payoutPosition: 0 })).toBeNull();
    expect(tryToMetagamePrize({ ...erc20Prize, amount: "" })).toBeNull();
    expect(tryToMetagamePrize(erc20Prize)).toEqual(
      toMetagameTokenPrize(asTokenPrize(erc20Prize)),
    );
    expect(tryToMetagamePrizes([
      erc20Prize,
      { ...erc721Prize, payoutPosition: 0 },
      extensionPrize,
      hydratedExtensionPrize,
      { ...erc20Prize, amount: "" },
    ])).toEqual([
      toMetagameTokenPrize(asTokenPrize(erc20Prize)),
      toMetagamePrize(hydratedExtensionPrize),
    ]);
  });

  test("throws when adapting malformed prize records", () => {
    expect(() => getTokenPrizes([{ ...erc20Prize, amount: "" }])).toThrow(
      "Cannot read malformed Budokan token prize (prizeId=1, tokenType=erc20)",
    );
    expect(() => toMetagamePrize({ ...erc20Prize, amount: "" })).toThrow(
      "Cannot adapt malformed Budokan prize (prizeId=1, tokenType=erc20)",
    );
    expect(() =>
      toMetagamePrizes([erc20Prize, { ...erc20Prize, amount: "" }]),
    ).toThrow(
      "Cannot adapt malformed Budokan prize (prizeId=1, tokenType=erc20)",
    );
    expect(() =>
      toMetagameTokenPrizes([{ ...erc721Prize, tokenId: "abc" }]),
    ).toThrow(
      "Cannot adapt malformed Budokan token prize (prizeId=2, tokenType=erc721)",
    );
  });
});
