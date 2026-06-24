import { describe, expect, test } from "bun:test";
import {
  parseDistribution,
  prizeDistribution,
  distributionPercentages,
  entryFeeSplit,
  entryFeePositionPayout,
  sponsorPrizePayout,
} from "../src/distribution/index.ts";
import type { Prize } from "../src/types/prize.ts";

describe("parseDistribution", () => {
  test("CairoCustomEnum variant shape (Exponential)", () => {
    expect(parseDistribution({ variant: { Exponential: 100 } })).toEqual({
      type: "exponential",
      weight: 100,
    });
  });
  test("PascalCase SDK shape (Linear)", () => {
    expect(parseDistribution({ Linear: 20, Exponential: undefined })).toEqual({
      type: "linear",
      weight: 20,
    });
  });
  test("lower-cased JSON (uniform)", () => {
    expect(parseDistribution({ uniform: {} })).toEqual({ type: "uniform", weight: 0 });
  });
  test("explicit { type, weight }", () => {
    expect(parseDistribution({ type: "exponential", weight: "50" })).toEqual({
      type: "exponential",
      weight: 50,
    });
  });
  test("custom carries raw bp weights", () => {
    expect(parseDistribution({ Custom: [5000, 3000, 2000] })).toEqual({
      type: "custom",
      weight: 0,
      customWeights: [5000, 3000, 2000],
    });
  });
  test("Option-wrapped weight", () => {
    expect(parseDistribution({ Linear: { Some: 30 } })).toEqual({
      type: "linear",
      weight: 30,
    });
  });
  test("garbage → unknown", () => {
    expect(parseDistribution(null)).toEqual({ type: "unknown", weight: 0 });
    expect(parseDistribution({})).toEqual({ type: "unknown", weight: 0 });
  });
});

describe("distributionPercentages", () => {
  test("uniform splits evenly and sums to ~100", () => {
    const pcts = distributionPercentages({ type: "uniform", weight: 0 }, 4);
    expect(pcts).toEqual([25, 25, 25, 25]);
  });

  test("custom returns bp/100 when length matches", () => {
    const pcts = distributionPercentages(
      { type: "custom", weight: 0, customWeights: [5000, 3000, 2000] },
      3,
    );
    expect(pcts).toEqual([50, 30, 20]);
  });

  test("custom falls back to uniform on length mismatch", () => {
    const pcts = distributionPercentages(
      { type: "custom", weight: 0, customWeights: [5000, 5000] },
      3,
    );
    expect(pcts.length).toBe(3);
    expect(pcts[0]).toBeCloseTo(33.33, 1);
  });

  test("linear is strictly decreasing and sums to ~100", () => {
    const pcts = distributionPercentages({ type: "linear", weight: 10 }, 5);
    expect(pcts.length).toBe(5);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeLessThan(pcts[i - 1]!);
    const sum = pcts.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(99.5);
    expect(sum).toBeLessThanOrEqual(100.01);
  });

  test("exponential weight is steeper than linear for the winner", () => {
    const lin = distributionPercentages({ type: "linear", weight: 100 }, 5);
    const exp = distributionPercentages({ type: "exponential", weight: 100 }, 5);
    expect(exp[0]).toBeGreaterThan(lin[0]!);
  });

  test("unknown falls back to uniform", () => {
    expect(distributionPercentages({ type: "unknown", weight: 0 }, 2)).toEqual([50, 50]);
  });

  test("count <= 0 → empty", () => {
    expect(distributionPercentages({ type: "uniform", weight: 0 }, 0)).toEqual([]);
  });

  test("matches the reference client formula (weight ÷ 10 then calculateDistribution)", () => {
    // On-chain weight 10 → client passes 1.0 → JS divides by 10 again.
    // Asserting the value pins parity with budokan client rendering.
    const pcts = distributionPercentages({ type: "linear", weight: 10 }, 3);
    // share_i = 1 + (positionValue-1)*0.1 → 1.2, 1.1, 1.0; total 3.3
    expect(pcts[0]).toBeCloseTo(36.36, 1);
    expect(pcts[1]).toBeCloseTo(33.33, 1);
    expect(pcts[2]).toBeCloseTo(30.3, 1);
  });
});

describe("entryFeeSplit", () => {
  test("position pool reserves protocol fee (sums within dust of total)", () => {
    const split = entryFeeSplit({
      amount: "1000",
      entryCount: 10, // total = 10_000
      tournamentCreatorShare: 1000, // 10%
      gameCreatorShare: 500, // 5%
      refundShare: 500, // 5%
      protocolFeeShare: 300, // 3%
    });
    expect(split.total).toBe(10_000n);
    expect(split.tournamentCreator).toBe(1000n);
    expect(split.gameCreator).toBe(500n);
    expect(split.refund).toBe(500n);
    expect(split.protocolFee).toBe(300n);
    // available = 10000 - 1000 - 500 - 500 - 300 = 7700 bps
    expect(split.availableShareBps).toBe(7700);
    expect(split.positionPool).toBe(7700n);
    const sum =
      split.positionPool +
      split.tournamentCreator +
      split.gameCreator +
      split.refund +
      split.protocolFee;
    expect(sum).toBe(10_000n);
  });

  test("omitting protocol fee over-counts the position pool (the bug this fixes)", () => {
    const base = {
      amount: "1000",
      entryCount: 10,
      tournamentCreatorShare: 1000,
      gameCreatorShare: 500,
      refundShare: 500,
    };
    const withProtocol = entryFeeSplit({ ...base, protocolFeeShare: 300 });
    const withoutProtocol = entryFeeSplit({ ...base, protocolFeeShare: 0 });
    expect(withoutProtocol.positionPool).toBeGreaterThan(withProtocol.positionPool);
    expect(withoutProtocol.positionPool - withProtocol.positionPool).toBe(300n);
  });

  test("shares exceeding 100% clamp available to 0", () => {
    const split = entryFeeSplit({
      amount: "1000",
      entryCount: 1,
      tournamentCreatorShare: 6000,
      gameCreatorShare: 5000,
    });
    expect(split.availableShareBps).toBe(0);
    expect(split.positionPool).toBe(0n);
  });
});

describe("entryFeePositionPayout", () => {
  const baseFee = {
    amount: "1000000",
    entryCount: 10, // total = 10_000_000
    tournamentCreatorShare: 0,
    gameCreatorShare: 0,
    refundShare: 0,
    distribution: { Uniform: {} },
    distributionCount: 4,
  };

  test("uniform 4-way split over full pool", () => {
    // available = 10000 bps, pool = 10_000_000, each = 25% → 2_500_000
    expect(entryFeePositionPayout(baseFee, 1)).toBe(2_500_000n);
    expect(entryFeePositionPayout(baseFee, 4)).toBe(2_500_000n);
  });

  test("protocol fee shrinks the per-position payout", () => {
    const withProtocol = entryFeePositionPayout(
      { ...baseFee, protocolFeeShare: 1000 }, // 10%
      1,
    );
    // pool = 90% of 10_000_000 = 9_000_000; 25% → 2_250_000
    expect(withProtocol).toBe(2_250_000n);
  });

  test("position outside paid range → 0", () => {
    expect(entryFeePositionPayout(baseFee, 5)).toBe(0n);
    expect(entryFeePositionPayout(baseFee, 0)).toBe(0n);
  });

  test("empty pool → 0", () => {
    expect(entryFeePositionPayout({ ...baseFee, entryCount: 0 }, 1)).toBe(0n);
  });
});

describe("sponsorPrizePayout", () => {
  const distributedPrize: Prize = {
    prizeId: "1",
    tournamentId: "10",
    payoutPosition: 0,
    tokenAddress: "0xerc20",
    tokenType: "erc20",
    amount: "1000000",
    tokenId: null,
    distributionType: "uniform",
    distributionWeight: null,
    distributionShares: null,
    distributionCount: 4,
    sponsorAddress: "0x0",
    extensionAddress: null,
    extensionConfig: null,
  };

  test("uniform distributed prize splits evenly", () => {
    expect(sponsorPrizePayout(distributedPrize, 1)).toBe(250_000n);
    expect(sponsorPrizePayout(distributedPrize, 4)).toBe(250_000n);
  });

  test("custom shares slice exactly", () => {
    const custom: Prize = {
      ...distributedPrize,
      distributionType: "custom",
      distributionShares: [5000, 3000, 2000],
      distributionCount: 3,
    };
    expect(sponsorPrizePayout(custom, 1)).toBe(500_000n);
    expect(sponsorPrizePayout(custom, 2)).toBe(300_000n);
    expect(sponsorPrizePayout(custom, 3)).toBe(200_000n);
  });

  test("non-distributed / erc721 / out-of-range → 0", () => {
    expect(sponsorPrizePayout({ ...distributedPrize, distributionCount: 0 }, 1)).toBe(0n);
    expect(sponsorPrizePayout(distributedPrize, 5)).toBe(0n);
    expect(
      sponsorPrizePayout({ ...distributedPrize, tokenType: "erc721" }, 1),
    ).toBe(0n);
  });
});

describe("prizeDistribution", () => {
  test("builds custom from distributionShares", () => {
    expect(
      prizeDistribution({
        distributionType: "custom",
        distributionWeight: null,
        distributionShares: [6000, 4000],
      }),
    ).toEqual({ type: "custom", weight: 0, customWeights: [6000, 4000] });
  });
  test("defaults weight to 10 when missing", () => {
    expect(
      prizeDistribution({
        distributionType: "linear",
        distributionWeight: null,
        distributionShares: null,
      }),
    ).toEqual({ type: "linear", weight: 10 });
  });
});
