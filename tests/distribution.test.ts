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

  test("matches the contract's Linear weights, not the old double-÷10 estimate", () => {
    // The contract's W(p) = 10 + (n - p) * w with w the raw on-chain weight,
    // so Linear(10) over 4 places is 40:30:20:10 — pinned by
    // game-components `test_linear_weights_are_exact` (first takes 4/10).
    //
    // The previous reference formula divided the weight by 10 twice
    // (`distributionPercentages` once, `calculateDistribution` again), which
    // rendered a curve 10x too shallow: 28.26% for the winner instead of 40%.
    // budokan.gg showed the same shallow curve, so the two agreed with each
    // other and disagreed with the chain.
    const pcts = distributionPercentages({ type: "linear", weight: 10 }, 4);
    expect(pcts[0]).toBeCloseTo(40, 5);
    expect(pcts[1]).toBeCloseTo(30, 5);
    expect(pcts[2]).toBeCloseTo(20, 5);
    expect(pcts[3]).toBeCloseTo(10, 5);
  });

  test("matches the contract's Exponential weights", () => {
    // Exponential(20) → k=2 over 3 places: weights 9:4:1, sum 14.
    // game-components `test_exponential_weights_are_exact`.
    // Percentages are 2-dp quantized (chart shape, not amounts) — same
    // resolution the legacy basis-point path returned.
    const pcts = distributionPercentages({ type: "exponential", weight: 20 }, 3);
    expect(pcts[0]).toBeCloseTo((9 / 14) * 100, 1);
    expect(pcts[1]).toBeCloseTo((4 / 14) * 100, 1);
    expect(pcts[2]).toBeCloseTo((1 / 14) * 100, 1);
  });

  test("geometric without params falls back to uniform", () => {
    // An API predating the distribution_params columns serves the type with
    // no ratio. Uniform is the documented fallback — approximate, never a
    // crash, and flagged via ClaimableReward.amountIsExact.
    expect(distributionPercentages({ type: "geometric", weight: 0 }, 4)).toEqual([
      25, 25, 25, 25,
    ]);
  });
});

describe("entryFeeSplit", () => {
  test("position pool reserves protocol fee (sums within dust of total)", () => {
    const split = entryFeeSplit({
      amount: "1000",
      entryCount: 10, // total = 10_000
      tournamentCreatorShare: 1000, // 10%
      gameFeeShare: 500, // 5%
      refundShare: 500, // 5%
      protocolFeeShare: 300, // 3%
    });
    expect(split.total).toBe(10_000n);
    expect(split.tournamentCreator).toBe(1000n);
    expect(split.gameFee).toBe(500n);
    expect(split.refund).toBe(500n);
    expect(split.protocolFee).toBe(300n);
    // available = 10000 - 1000 - 500 - 500 - 300 = 7700 bps
    expect(split.availableShareBps).toBe(7700);
    expect(split.positionPool).toBe(7700n);
    const sum =
      split.positionPool +
      split.tournamentCreator +
      split.gameFee +
      split.refund +
      split.protocolFee;
    expect(sum).toBe(10_000n);
  });

  test("omitting protocol fee over-counts the position pool (the bug this fixes)", () => {
    const base = {
      amount: "1000",
      entryCount: 10,
      tournamentCreatorShare: 1000,
      gameFeeShare: 500,
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
      gameFeeShare: 5000,
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
    gameFeeShare: 0,
    refundShare: 0,
    distribution: { Uniform: {} },
    distributionCount: 4,
    distributionParams: null,
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
    distributionParams: null,
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
      distributionParams: null,
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
        distributionParams: null,
      }),
    ).toEqual({ type: "custom", weight: 0, customWeights: [6000, 4000] });
  });
  test("defaults weight to 10 when missing", () => {
    expect(
      prizeDistribution({
        distributionType: "linear",
        distributionWeight: null,
        distributionShares: null,
        distributionParams: null,
      }),
    ).toEqual({ type: "linear", weight: 10 });
  });
});

describe("parseDistribution — API Custom shape", () => {
  test("{type:'Custom', shares} keeps the shares (tournament 33 regression)", () => {
    const parsed = parseDistribution({
      type: "Custom",
      shares: [3000, 2000, 1400, 1000, 800, 600, 400, 300, 300, 200],
    });
    expect(parsed.type).toBe("custom");
    expect(parsed.customWeights).toEqual([3000, 2000, 1400, 1000, 800, 600, 400, 300, 300, 200]);
    // Percent per position — NOT uniform 10s.
    expect(distributionPercentages(parsed, 10)).toEqual([30, 20, 14, 10, 8, 6, 4, 3, 3, 2]);
  });
});

// =========================================================================
// Exact payout maths — values pinned against the contract's own tests
// =========================================================================

import {
  exactPayoutAt,
  exactPayouts,
  maxGeometricPayouts,
  validateDistributionSpec,
} from "../src/distribution/exact.ts";

describe("exactPayoutAt", () => {
  test("linear w1.0, 5 places, 10000 pool matches the contract split", () => {
    const spec = { kind: "linear", weight: 1 } as const;
    expect(exactPayouts(spec, 5, 10_000n)).toEqual([3333n, 2666n, 2000n, 1333n, 666n]);
  });

  test("exponential k=5 winner over 10 places matches the contract", () => {
    expect(
      exactPayoutAt({ kind: "exponential", weight: 5 }, 1, 10, 1_000_000n),
    ).toBe(452_847n);
  });

  test("geometric (10,7): each place gets 70% of the one above, to a unit", () => {
    const spec = { kind: "geometric", ratioA: 10, ratioB: 7 } as const;
    const pool = 1_000_000_000_000_000_000n;
    expect(exactPayoutAt(spec, 1, 10, pool)).toBe(308720592627384808n);
    expect(exactPayoutAt(spec, 2, 10, pool)).toBe(216104414839169366n);
  });

  test("tiered flagship over 10,000 places matches the contract end-to-end", () => {
    const spec = {
      kind: "tiered",
      ratioA: 10,
      ratioB: 7,
      headCount: 39,
      headShareBps: 8000,
    } as const;
    const pool = 1_000_000_000_000_000_000n;
    expect(exactPayoutAt(spec, 1, 10000, pool)).toBe(240000218290681776n);
    expect(exactPayoutAt(spec, 2, 10000, pool)).toBe(168000152803477243n);
    expect(exactPayoutAt(spec, 40, 10000, pool)).toBe(20078305391024n);
    expect(exactPayoutAt(spec, 10000, 10000, pool)).toBe(20078305391024n);
  });
});

describe("maxGeometricPayouts", () => {
  test("matches the contract's documented reach", () => {
    expect(maxGeometricPayouts(2)).toBe(129);
    expect(maxGeometricPayouts(3)).toBe(81);
    expect(maxGeometricPayouts(10)).toBe(39);
  });
});

describe("validateDistributionSpec", () => {
  test("dynamic-count geometric is refused, mirroring the contract", () => {
    const v = validateDistributionSpec({ kind: "geometric", ratioA: 10, ratioB: 7 }, 0);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("fixed paid-places count");
  });

  test("geometric past its reach is refused with the bound", () => {
    const v = validateDistributionSpec({ kind: "geometric", ratioA: 10, ratioB: 7 }, 40);
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("at most 39 places");
  });

  test("tiered needs count > head and a head share inside (0, 100%)", () => {
    const bad = validateDistributionSpec(
      { kind: "tiered", ratioA: 10, ratioB: 7, headCount: 39, headShareBps: 8000 },
      39,
    );
    expect(bad.ok).toBe(false);
    const good = validateDistributionSpec(
      { kind: "tiered", ratioA: 10, ratioB: 7, headCount: 39, headShareBps: 8000 },
      10000,
    );
    expect(good.ok).toBe(true);
  });

  test("last-place-pays-zero is caught when the pool is known", () => {
    const v = validateDistributionSpec(
      { kind: "exponential", weight: 3 },
      200,
      1_000_000n,
    );
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toContain("Last place would receive zero");
  });
});

import { recommendDistribution, validateDistributionSpec as vds } from "../src/distribution/exact.ts";

describe("recommendDistribution", () => {
  const styles = ["equal", "gentle", "balanced", "topHeavy", "winnerTakesMost"] as const;
  const sizes = [1, 2, 3, 10, 39, 40, 100, 129, 130, 500, 3000, 10000];

  test("every style validates at every field size — the curve adapts to the count", () => {
    for (const style of styles) {
      for (const n of sizes) {
        const spec = recommendDistribution(style, n);
        const v = vds(spec, n);
        if (!v.ok) throw new Error(`${style}@${n}: ${v.errors.join("; ")} (${JSON.stringify(spec)})`);
      }
    }
  });

  test("steep styles hold their headline share across the geometric/tiered switch", () => {
    // 30 places: pure geometric, 1st ≈ 30%. 300 places: tiered, head keeps
    // the decay — 1st still gets a real headline, not a power-law fade.
    const small = recommendDistribution("topHeavy", 30);
    const large = recommendDistribution("topHeavy", 300);
    expect(small.kind).toBe("geometric");
    expect(large.kind).toBe("tiered");
    const p1Small = exactPayoutAt(small, 1, 30, 1_000_000n);
    const p1Large = exactPayoutAt(large, 1, 300, 1_000_000n);
    expect(Number(p1Small)).toBeGreaterThan(250_000); // ~30%
    expect(Number(p1Large)).toBeGreaterThan(150_000); // headline survives scale
  });

  test("tiered heads are derived from the count, never force the count up", () => {
    for (const n of [40, 50, 500, 10000]) {
      const spec = recommendDistribution("winnerTakesMost", n);
      if (spec.kind === "tiered") expect(spec.headCount).toBeLessThan(n);
    }
  });
});

// ===========================================================================
// Contract parity for the post-#311 curves.
//
// Every expected value below is lifted from game-components v1.1.12's own
// payout tests (`packages/utilities/src/distribution/tests/test_payout.cairo`)
// — the exact code the deployed contract settles with. If one of these drifts,
// the SDK is quoting an amount the chain will not transfer.
// ===========================================================================
describe("Geometric / Tiered parity with the contract", () => {
  test("parses the Cairo tuple shape for Geometric", () => {
    // Cairo `(u16, u16)` reaches starknet.js as numeric keys.
    expect(parseDistribution({ variant: { Geometric: { 0: 10, 1: 7 } } })).toEqual({
      type: "geometric",
      weight: 0,
      ratioA: 10,
      ratioB: 7,
    });
  });

  test("parses the API's snake_case shape for Geometric", () => {
    expect(
      parseDistribution({ type: "Geometric", ratio_a: 10, ratio_b: 7 }),
    ).toEqual({ type: "geometric", weight: 0, ratioA: 10, ratioB: 7 });
  });

  test("parses Tiered, flattening the nested head_ratio tuple", () => {
    expect(
      parseDistribution({
        variant: {
          Tiered: { head_ratio: { 0: 10, 1: 7 }, head_count: 39, head_share_bps: 8000 },
        },
      }),
    ).toEqual({
      type: "tiered",
      weight: 0,
      ratioA: 10,
      ratioB: 7,
      headCount: 39,
      headShareBps: 8000,
    });
  });

  test("parses the API's flat snake_case shape for Tiered", () => {
    expect(
      parseDistribution({
        type: "Tiered",
        ratio_a: 10,
        ratio_b: 7,
        head_count: 39,
        head_share_bps: 8000,
      }),
    ).toEqual({
      type: "tiered",
      weight: 0,
      ratioA: 10,
      ratioB: 7,
      headCount: 39,
      headShareBps: 8000,
    });
  });

  test("Geometric(10,7) entry-fee payouts match calculate_payout exactly", () => {
    // test_geometric_ratio_holds_between_adjacent_positions: pool 1e18,
    // n = 10 → 1st 308720592627384808, 2nd 216104414839169366.
    const input = {
      amount: 10n ** 18n, // one entry, whole pool to positions
      entryCount: 1,
      tournamentCreatorShare: 0,
      gameFeeShare: 0,
      refundShare: 0,
      protocolFeeShare: 0,
      distribution: { type: "Geometric", ratio_a: 10, ratio_b: 7 },
      distributionCount: 10,
      distributionParams: null,
    };
    expect(entryFeePositionPayout(input, 1)).toBe(308720592627384808n);
    expect(entryFeePositionPayout(input, 2)).toBe(216104414839169366n);
  });

  test("the flagship Tiered curve matches calculate_payout over 10,000 places", () => {
    // test_tiered_pays_a_headline_first_prize_over_ten_thousand_places.
    const prize = {
      prizeId: "1",
      tournamentId: "1",
      payoutPosition: 0,
      tokenAddress: "0xtoken",
      tokenType: "erc20" as const,
      amount: (10n ** 18n).toString(),
      tokenId: null,
      distributionType: "tiered",
      distributionWeight: null,
      distributionShares: null,
      distributionParams: {
        ratioA: 10,
        ratioB: 7,
        headCount: 39,
        headShareBps: 8000,
      },
      distributionCount: 10000,
      sponsorAddress: "0xsponsor",
      extensionAddress: null,
      extensionConfig: null,
    } satisfies Prize;

    expect(sponsorPrizePayout(prize, 1)).toBe(240000218290681776n);
    expect(sponsorPrizePayout(prize, 2)).toBe(168000152803477243n);
    expect(sponsorPrizePayout(prize, 39)).toBe(311843831108n);
    // Every tail place takes an identical slice of what the head left.
    expect(sponsorPrizePayout(prize, 40)).toBe(20078305391024n);
    expect(sponsorPrizePayout(prize, 10000)).toBe(20078305391024n);
  });

  test("a Geometric prize without params is approximated, not dropped", () => {
    // The reward must still surface — hiding a real claim is worse than
    // quoting it approximately (flagged by ClaimableReward.amountIsExact).
    const prize = {
      prizeId: "1",
      tournamentId: "1",
      payoutPosition: 0,
      tokenAddress: "0xtoken",
      tokenType: "erc20" as const,
      amount: "1000",
      tokenId: null,
      distributionType: "geometric",
      distributionWeight: null,
      distributionShares: null,
      distributionParams: null,
      distributionCount: 4,
      sponsorAddress: "0xsponsor",
      extensionAddress: null,
      extensionConfig: null,
    } satisfies Prize;

    expect(sponsorPrizePayout(prize, 1)).toBe(250n);
    expect(sponsorPrizePayout(prize, 4)).toBe(250n);
  });
});
