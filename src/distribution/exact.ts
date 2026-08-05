/**
 * Exact payout maths for all six Budokan distribution curves, mirroring the
 * contract's settlement (`game-components distribution::payout`): integer
 * bigint arithmetic, `pool * W(p) / sum(W)`, truncated down. A previewed
 * amount equals the amount the contract will transfer.
 *
 * Also the authoring-time validator: `validateDistributionSpec` applies the
 * same rules the contract asserts at `create_tournament` / `add_prize`, so a
 * form can refuse a config client-side with the same reasoning the chain
 * would use — including the reach bound on geometric ratios and the
 * "last place must pay at least one unit" rule.
 */

import type { DistributionSpec } from "../calldata/index.js";

/** Mirror of the contract's `MAX_EXACT_EXPONENT`. */
export const MAX_EXACT_EXPONENT = 5;

/**
 * The largest paid-place count a geometric ratio can represent — mirror of
 * `max_geometric_payouts`. The heaviest weight is `a^(n-1)`; keeping it
 * within 2^128 keeps `pool * W(1)` inside u256 for any u128 pool.
 */
export function maxGeometricPayouts(ratioA: number): number {
  if (ratioA < 2) return 0;
  const limit = 1n << 128n;
  const base = BigInt(ratioA);
  let acc = 1n;
  let n = 1;
  while (acc <= limit / base) {
    acc *= base;
    n += 1;
  }
  return n;
}

function intPow(base: bigint, exp: number): bigint {
  let acc = 1n;
  let b = base;
  let e = exp;
  while (e > 0) {
    if (e % 2 === 1) acc *= b;
    e = Math.floor(e / 2);
    if (e > 0) b *= b;
  }
  return acc;
}

/** sum_{j=1..n} j^k for k in 1..=5 (Faulhaber identities, exact). */
function powerSum(k: number, n: bigint): bigint {
  const n1 = n + 1n;
  switch (k) {
    case 1: return (n * n1) / 2n;
    case 2: return (n * n1 * (2n * n + 1n)) / 6n;
    case 3: return (n * n * n1 * n1) / 4n;
    case 4: return (n * n1 * (2n * n + 1n) * (3n * n * n + 3n * n - 1n)) / 30n;
    case 5: return (n * n * n1 * n1 * (2n * n * n + 2n * n - 1n)) / 12n;
    default: throw new Error(`exponent ${k} exceeds MAX_EXACT_EXPONENT`);
  }
}

function weightAt(spec: DistributionSpec, p: number, n: number): bigint {
  switch (spec.kind) {
    case "uniform": return 1n;
    case "linear": return 10n + BigInt(n - p) * BigInt(Math.round(spec.weight * 10));
    case "exponential": return intPow(BigInt(n - p + 1), Math.round(spec.weight));
    case "custom": return BigInt(spec.weights[p - 1] ?? 0);
    case "geometric":
      return intPow(BigInt(spec.ratioA), n - p) * intPow(BigInt(spec.ratioB), p - 1);
    case "tiered": throw new Error("tiered is settled per-tier, not by weights");
  }
}

function weightSum(spec: DistributionSpec, n: number): bigint {
  switch (spec.kind) {
    case "uniform": return BigInt(n);
    case "linear": {
      const w = BigInt(Math.round(spec.weight * 10));
      const nn = BigInt(n);
      return 10n * nn + (w * nn * (nn - 1n)) / 2n;
    }
    case "exponential": return powerSum(Math.round(spec.weight), BigInt(n));
    case "custom":
      return spec.weights.slice(0, n).reduce((a, b) => a + BigInt(b), 0n);
    case "geometric": {
      const a = BigInt(spec.ratioA);
      const b = BigInt(spec.ratioB);
      return (intPow(a, n) - intPow(b, n)) / (a - b);
    }
    case "tiered": throw new Error("tiered is settled per-tier, not by weights");
  }
}

/**
 * The payout for one 1-indexed position, in smallest token units — exactly
 * what the contract transfers. Returns 0n out of range.
 */
export function exactPayoutAt(
  spec: DistributionSpec,
  position: number,
  totalPositions: number,
  pool: bigint,
): bigint {
  if (position < 1 || position > totalPositions || pool <= 0n) return 0n;

  if (spec.kind === "tiered") {
    const m = spec.headCount;
    const headPool = (pool * BigInt(spec.headShareBps)) / 10000n;
    if (position <= m) {
      const head: DistributionSpec = {
        kind: "geometric",
        ratioA: spec.ratioA,
        ratioB: spec.ratioB,
      };
      return (headPool * weightAt(head, position, m)) / weightSum(head, m);
    }
    return (pool - headPool) / BigInt(totalPositions - m);
  }

  const denom = weightSum(spec, totalPositions);
  if (denom <= 0n) return 0n;
  return (pool * weightAt(spec, position, totalPositions)) / denom;
}

/** Every position's payout; zero-amount tails are kept, not dropped. */
export function exactPayouts(
  spec: DistributionSpec,
  totalPositions: number,
  pool: bigint,
): bigint[] {
  return Array.from({ length: totalPositions }, (_, i) =>
    exactPayoutAt(spec, i + 1, totalPositions, pool),
  );
}

/**
 * Percentage view for charts (0–100, floats). Shape only — use
 * `exactPayouts` for amounts.
 */
export function payoutPercentages(
  spec: DistributionSpec,
  totalPositions: number,
): number[] {
  const SCALE = 1_000_000n;
  return exactPayouts(spec, totalPositions, SCALE).map(
    (v) => Number((v * 10000n) / SCALE) / 100,
  );
}

export interface DistributionValidation {
  ok: boolean;
  /** Human-readable reasons, mirroring the contract's creation asserts. */
  errors: string[];
}

/**
 * Authoring-time validation, mirroring the contract's creation rules. Pass
 * `pool` (escrowed amount in smallest units) to also apply the
 * last-place-pays rule the contract enforces for prizes with a fixed count.
 * `distributionCount = 0` means dynamic (leaderboard-sized).
 */
export function validateDistributionSpec(
  spec: DistributionSpec,
  distributionCount: number,
  pool?: bigint,
): DistributionValidation {
  const errors: string[] = [];

  if (spec.kind === "exponential") {
    const k = spec.weight;
    if (!Number.isInteger(k) || k < 1 || k > MAX_EXACT_EXPONENT) {
      errors.push(
        `Exponential steepness must be a whole number from 1 to ${MAX_EXACT_EXPONENT}`,
      );
    }
  }

  if (spec.kind === "custom") {
    if (distributionCount === 0) {
      errors.push("Custom requires a fixed paid-places count");
    } else if (spec.weights.length !== distributionCount) {
      errors.push(
        `Custom needs one share per paid place (${spec.weights.length} shares for ${distributionCount} places)`,
      );
    }
    const sum = spec.weights.reduce((a, b) => a + b, 0);
    if (sum !== 10000) errors.push(`Custom shares must sum to 10000 bps, got ${sum}`);
  }

  if (spec.kind === "geometric" || spec.kind === "tiered") {
    const { ratioA: a, ratioB: b } = spec;
    if (!Number.isInteger(a) || !Number.isInteger(b) || b < 1 || a <= b || a > 255) {
      errors.push("Decay ratio must satisfy 255 >= a > b > 0");
    } else {
      const reach = maxGeometricPayouts(a);
      if (spec.kind === "geometric") {
        if (distributionCount === 0) {
          errors.push("Geometric requires a fixed paid-places count");
        } else if (distributionCount > reach) {
          errors.push(
            `This ratio reaches at most ${reach} places — use a coarser ratio or Tiered`,
          );
        }
      } else {
        if (spec.headCount > reach) {
          errors.push(`The head ratio reaches at most ${reach} places`);
        }
        if (distributionCount === 0 || distributionCount <= spec.headCount) {
          errors.push(
            "Tiered requires a fixed paid-places count greater than the head size",
          );
        }
        if (spec.headShareBps <= 0 || spec.headShareBps >= 10000) {
          errors.push("Head share must be strictly between 0% and 100%");
        }
      }
    }
  }

  // Last place must pay at least one indivisible unit for the escrowed pool —
  // the contract refuses this at add_prize for fixed counts.
  if (errors.length === 0 && pool !== undefined && distributionCount > 0) {
    const last = exactPayoutAt(spec, distributionCount, distributionCount, pool);
    if (last <= 0n) {
      errors.push(
        "Last place would receive zero at this pool size — raise the amount or lower the paid-places count",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
