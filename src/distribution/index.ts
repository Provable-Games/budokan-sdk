/**
 * Pure distribution + entry-fee math for Budokan.
 *
 * This module is the single source of truth for "how much does position N
 * get?" — the same arithmetic the budokan client used to duplicate in
 * `computeEntryFeeAmount` / `computePrizePercentages` / `processEntryFeePrizes`.
 *
 * All functions are pure: no I/O, no contract calls, no `Date.now()`. Token
 * amounts are `bigint` in smallest token units; basis-point shares are plain
 * numbers (0–10000). USD conversion, decimals, and formatting stay in the
 * consumer.
 *
 * Distribution percentages are computed with the shared `calculateDistribution`
 * from `@provable-games/metagame-sdk` — the *exact* function the budokan client
 * renders payouts with — so amounts match between the SDK, budokan.gg, and any
 * third-party integration. (The final on-chain claim amount is computed by the
 * contract's fixed-point math; these values are the canonical client-side
 * estimate, suitable for display and for filtering unclaimable zero slices.)
 *
 * Entry-fee split semantics follow the contract
 * (`packages/rewards/src/budokan_rewards.cairo::_claim_entry_fee_position`):
 * the position pool is the entry-fee pool **minus** the tournament-creator,
 * game-creator, refund, *and protocol-fee* shares. The client historically
 * omitted the protocol fee here and over-counted the position pool — this
 * module fixes that by taking `protocolFeeShare` as an explicit input.
 */

import type { DistributionSpec } from "../calldata/index.js";
import type { Prize } from "../types/prize.js";
import { MAX_EXACT_EXPONENT, exactPayoutAt, payoutPercentages } from "./exact.js";

const BASIS_POINTS = 10000n;

type CurveType = "linear" | "exponential" | "uniform";

/**
 * Per-position basis-point curve → percentages (0–100). Ported verbatim from
 * `@provable-games/metagame-sdk`'s `calculateDistribution` (the function the
 * budokan client renders payouts with) so the SDK has no runtime dependency on
 * it and stays the single source of truth. `weight` is in client units (the
 * caller divides the on-chain ×10 weight before passing it here); the
 * normalized rounding dust is rolled into position 1, exactly as on the client.
 */
function calculateDistribution(
  positions: number,
  weight: number,
  distributionType: CurveType,
): number[] {
  if (positions <= 0) return [];

  let raw: number[];
  if (distributionType === "uniform") {
    raw = Array(positions).fill(1);
  } else if (distributionType === "linear") {
    raw = [];
    for (let i = 0; i < positions; i++) {
      const positionValue = positions - i;
      raw.push(1 + (positionValue - 1) * (weight / 10));
    }
  } else {
    raw = [];
    for (let i = 0; i < positions; i++) {
      raw.push(Math.pow(1 - i / positions, weight));
    }
  }

  const total = raw.reduce((a, b) => a + b, 0);
  if (total === 0) return Array(positions).fill(0);

  const bpShares = raw.map((d) => Math.floor((d / total) * 1e4));
  const remaining = 1e4 - bpShares.reduce((a, b) => a + b, 0);
  if (remaining !== 0) bpShares[0] = bpShares[0]! + remaining;
  return bpShares.map((bp) => bp / 100);
}

export type DistributionKind =
  | "linear"
  | "exponential"
  | "uniform"
  | "custom"
  | "geometric"
  | "tiered"
  | "unknown";

export interface ParsedDistribution {
  type: DistributionKind;
  /**
   * Raw weight as stored on-chain (scaled ×10 — e.g. `10` = 1.0). `0` for
   * Uniform/Custom/Geometric/Tiered. `distributionPercentages` divides by 10
   * internally.
   */
  weight: number;
  /** For Custom distributions, the raw u16 basis-point shares (one per paid position). */
  customWeights?: number[];
  /**
   * Geometric/Tiered decay ratio: each place takes `ratioB / ratioA` of the
   * one above it. Absent when the source didn't carry the curve parameters
   * (an API older than the `distribution_params` columns), in which case the
   * curve cannot be reproduced and callers fall back to Uniform.
   */
  ratioA?: number;
  ratioB?: number;
  /** Tiered only: geometric head size, and the share of the pool it takes (bps). */
  headCount?: number;
  headShareBps?: number;
}

const KNOWN_KEYS: Record<string, DistributionKind> = {
  linear: "linear",
  exponential: "exponential",
  uniform: "uniform",
  custom: "custom",
  geometric: "geometric",
  tiered: "tiered",
};

/**
 * Read Geometric/Tiered curve parameters out of whichever wire shape carried
 * them: the API's snake_case (`ratio_a`), the SDK/indexer camelCase
 * (`ratioA`), or the Cairo tuple starknet.js renders as numeric keys
 * (`{ "0": a, "1": b }`). Missing values stay `undefined` so callers can tell
 * "no params" from "zero".
 */
function extractCurveParams(
  kind: DistributionKind,
  bag: Record<string, unknown>,
): Pick<ParsedDistribution, "ratioA" | "ratioB" | "headCount" | "headShareBps"> {
  if (kind !== "geometric" && kind !== "tiered") return {};
  const num = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const params: Pick<
    ParsedDistribution,
    "ratioA" | "ratioB" | "headCount" | "headShareBps"
  > = {
    ratioA: num(bag.ratio_a ?? bag.ratioA ?? (bag as Record<string, unknown>)["0"]),
    ratioB: num(bag.ratio_b ?? bag.ratioB ?? (bag as Record<string, unknown>)["1"]),
  };
  if (kind === "tiered") {
    params.headCount = num(bag.head_count ?? bag.headCount);
    params.headShareBps = num(bag.head_share_bps ?? bag.headShareBps);
  }
  return params;
}

/** Tiered nests its ratio in a `head_ratio` tuple; flatten it onto the bag. */
function flattenHeadRatio(inner: Record<string, unknown>): Record<string, unknown> {
  const hr = inner.head_ratio ?? inner.headRatio;
  return typeof hr === "object" && hr !== null
    ? { ...inner, ...(hr as Record<string, unknown>) }
    : inner;
}

/**
 * Normalize the many wire shapes of the Cairo `Distribution` enum into a flat
 * `{ type, weight, customWeights }`. Handles:
 *   - starknet.js v9 CairoCustomEnum: `{ variant: { Exponential: 100 } }`
 *   - SDK / PascalCase: `{ Exponential: 100 }`
 *   - lower-cased JSON (indexer/API): `{ exponential: 100 }`
 *   - explicit `{ type, weight }`
 *   - `Option`-wrapped weights (`{ Some: n }`)
 *
 * Unknown / missing input → `{ type: "unknown", weight: 0 }`, which
 * `distributionPercentages` treats as Uniform.
 */
export function parseDistribution(dist: unknown): ParsedDistribution {
  if (!dist || typeof dist !== "object") {
    return { type: "unknown", weight: 0 };
  }

  // `{ type, weight }` / `{ type, shares }` explicit shape (the API returns
  // Custom distributions as `{ type: "Custom", shares: [u16 bps…] }`).
  const explicit = dist as {
    type?: string;
    weight?: number | string;
    shares?: unknown[];
    customWeights?: unknown[];
  };
  if (typeof explicit.type === "string") {
    const kind = KNOWN_KEYS[explicit.type.toLowerCase()] ?? "unknown";
    if (kind === "custom") {
      const shares = explicit.shares ?? explicit.customWeights;
      return {
        type: "custom",
        weight: 0,
        customWeights: Array.isArray(shares) ? shares.map((v) => Number(v)) : [],
      };
    }
    if (kind === "geometric" || kind === "tiered") {
      // The API serves the params flattened onto the distribution object; the
      // indexer/SDK nest them under `params` / `distributionParams`.
      const rec = dist as Record<string, unknown>;
      const nested = (rec.params ?? rec.distributionParams) as unknown;
      const bag = flattenHeadRatio({
        ...rec,
        ...(typeof nested === "object" && nested !== null
          ? (nested as Record<string, unknown>)
          : {}),
      });
      return { type: kind, weight: 0, ...extractCurveParams(kind, bag) };
    }
    return { type: kind, weight: Number(explicit.weight ?? 0) };
  }

  // Unwrap a CairoCustomEnum `.variant` layer if present.
  const bag = ((dist as { variant?: Record<string, unknown> }).variant ??
    (dist as Record<string, unknown>)) as Record<string, unknown>;

  for (const [rawKey, value] of Object.entries(bag)) {
    if (value === undefined || value === null) continue;
    const kind = KNOWN_KEYS[rawKey.toLowerCase()];
    if (!kind) continue;

    if (kind === "uniform") return { type: "uniform", weight: 0 };

    if (kind === "custom") {
      const arr = Array.isArray(value) ? value.map((v) => Number(v)) : [];
      return { type: "custom", weight: 0, customWeights: arr };
    }

    // Geometric carries a `(u16, u16)` tuple; Tiered a struct whose ratio is
    // itself a nested tuple. Both arrive as objects, never a bare number.
    if (kind === "geometric" || kind === "tiered") {
      const inner =
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)
          : {};
      return {
        type: kind,
        weight: 0,
        ...extractCurveParams(kind, flattenHeadRatio(inner)),
      };
    }

    // Linear / Exponential carry a numeric weight.
    if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") {
      return { type: kind, weight: Number(value) };
    }
    if (typeof value === "object" && value !== null && "Some" in value) {
      return { type: kind, weight: Number((value as { Some: unknown }).Some) };
    }
    return { type: kind, weight: 0 };
  }

  return { type: "unknown", weight: 0 };
}

/**
 * Build a `ParsedDistribution` from the flat fields the SDK carries on a
 * sponsored `Prize` (`distributionType` / `distributionWeight` /
 * `distributionShares`).
 */
export function prizeDistribution(prize: Pick<
  Prize,
  | "distributionType"
  | "distributionWeight"
  | "distributionShares"
  | "distributionParams"
>): ParsedDistribution {
  const type = KNOWN_KEYS[String(prize.distributionType ?? "uniform").toLowerCase()] ?? "uniform";
  if (type === "custom") {
    return { type, weight: 0, customWeights: prize.distributionShares ?? [] };
  }
  if (type === "geometric" || type === "tiered") {
    const bag = flattenHeadRatio(
      (prize.distributionParams ?? {}) as Record<string, unknown>,
    );
    return { type, weight: 0, ...extractCurveParams(type, bag) };
  }
  // Default weight matches the client (10 → 1.0) when missing.
  return { type, weight: prize.distributionWeight ?? 10 };
}

/**
 * Lift a parsed distribution to the {@link DistributionSpec} the exact
 * settlement maths consumes, or `null` when the curve can't be reproduced
 * faithfully. Callers fall back to the legacy basis-point estimate on `null`.
 *
 * Returns `null` for:
 *  - `unknown` — an unrecognized variant,
 *  - Geometric/Tiered whose parameters didn't survive the wire (see
 *    `ParsedDistribution.ratioA`),
 *  - Exponential at a fractional exponent. The contract has refused these
 *    since #311 ("whole number from 1 to 5"), but tournaments created on the
 *    pre-#311 deployment can still carry one, and those settle with the old
 *    basis-point maths — so the estimate must too.
 *  - Custom whose share count doesn't match the paid places.
 */
export function toDistributionSpec(
  dist: ParsedDistribution,
  count: number,
): DistributionSpec | null {
  switch (dist.type) {
    case "uniform":
      return { kind: "uniform" };
    case "linear":
      // On-chain weight is ×10; DistributionSpec carries client units.
      return { kind: "linear", weight: dist.weight / 10 };
    case "exponential": {
      const k = dist.weight / 10;
      if (!Number.isInteger(k) || k < 1 || k > MAX_EXACT_EXPONENT) return null;
      return { kind: "exponential", weight: k };
    }
    case "custom": {
      const weights = dist.customWeights ?? [];
      if (weights.length !== count) return null;
      return { kind: "custom", weights };
    }
    case "geometric": {
      const { ratioA, ratioB } = dist;
      if (!isRatio(ratioA, ratioB)) return null;
      return { kind: "geometric", ratioA: ratioA as number, ratioB: ratioB as number };
    }
    case "tiered": {
      const { ratioA, ratioB, headCount, headShareBps } = dist;
      if (!isRatio(ratioA, ratioB)) return null;
      if (
        !Number.isInteger(headCount) ||
        !Number.isInteger(headShareBps) ||
        (headCount as number) < 1 ||
        (headShareBps as number) <= 0 ||
        (headShareBps as number) >= 10000 ||
        // The tail divisor `count - headCount` must be positive, exactly as
        // the contract asserts before settling.
        count <= (headCount as number)
      ) {
        return null;
      }
      return {
        kind: "tiered",
        ratioA: ratioA as number,
        ratioB: ratioB as number,
        headCount: headCount as number,
        headShareBps: headShareBps as number,
      };
    }
    default:
      return null;
  }
}

/** The contract's ratio rule: `255 >= a > b > 0`, both whole. */
function isRatio(a: number | undefined, b: number | undefined): boolean {
  return (
    Number.isInteger(a) &&
    Number.isInteger(b) &&
    (b as number) > 0 &&
    (a as number) > (b as number) &&
    (a as number) <= 255
  );
}

/**
 * Per-position percentages (each 0–100, summing to ~100) for a distribution
 * across `count` paid positions. Generalizes the client's
 * `computeEntryFeePercentages` / `computePrizePercentages`.
 *
 * - linear/exponential: delegates to metagame-sdk's `calculateDistribution`
 *   (weight is divided by 10 to undo the on-chain ×10 scaling).
 * - uniform / unknown: equal split.
 * - custom: raw basis-point shares ÷ 100; falls back to uniform when the
 *   shares array length doesn't match `count`.
 */
export function distributionPercentages(
  dist: ParsedDistribution,
  count: number,
): number[] {
  if (count <= 0) return [];

  // Preferred path: the same integer maths the contract settles with, so the
  // rendered shape matches the transferred amounts for every supported curve.
  const spec = toDistributionSpec(dist, count);
  if (spec) return payoutPercentages(spec, count);

  if (dist.type === "custom") {
    const cw = dist.customWeights ?? [];
    if (cw.length === count) return cw.map((bp) => bp / 100);
    return calculateDistribution(count, 1, "uniform");
  }

  const distType: CurveType =
    dist.type === "linear" || dist.type === "exponential" || dist.type === "uniform"
      ? dist.type
      : "uniform";
  // Weight is stored ×10 on-chain; `calculateDistribution` expects client units.
  return calculateDistribution(count, dist.weight / 10, distType);
}

/** Input shape for entry-fee split math. Mirrors the on-chain built-in `EntryFee`
 *  plus the per-tournament protocol-fee snapshot (carried on `Tournament`). */
export interface EntryFeeSplitInput {
  /** Per-entry fee in smallest token units (decimal string or bigint). */
  amount: string | bigint;
  /** Number of paid entries collected. */
  entryCount: number;
  /** Basis-point shares (0–10000). Omitted / null → 0. */
  tournamentCreatorShare?: number | null;
  gameFeeShare?: number | null;
  refundShare?: number | null;
  /** Protocol-fee bps snapshotted for the tournament (`Tournament.protocolFeeShare`). */
  protocolFeeShare?: number | null;
}

export interface EntryFeeSplit {
  /** Total fee pool = amount × entryCount. */
  total: bigint;
  /** Pool shared across leaderboard positions = floor(availableShare × total / 10000). */
  positionPool: bigint;
  tournamentCreator: bigint;
  gameFee: bigint;
  refund: bigint;
  protocolFee: bigint;
  /** Basis points left for positions after fixed shares (clamped ≥ 0). */
  availableShareBps: number;
}

function bps(total: bigint, share: number | null | undefined): bigint {
  const b = Number(share ?? 0);
  if (b <= 0) return 0n;
  return (total * BigInt(b)) / BASIS_POINTS;
}

/**
 * Split a built-in entry-fee pool into its on-chain components. The position
 * pool reserves the tournament-creator, game-creator, refund, *and* protocol
 * fee — matching `_claim_entry_fee_position`'s `available_share`.
 *
 * Note: each component is floored independently (sub-wei dust may not sum to
 * `total`, exactly as on-chain).
 */
export function entryFeeSplit(input: EntryFeeSplitInput): EntryFeeSplit {
  const total = BigInt(input.amount ?? 0) * BigInt(input.entryCount ?? 0);
  const creator = Number(input.tournamentCreatorShare ?? 0);
  const game = Number(input.gameFeeShare ?? 0);
  const refund = Number(input.refundShare ?? 0);
  const protocol = Number(input.protocolFeeShare ?? 0);
  const availableShareBps = Math.max(0, 10000 - creator - game - refund - protocol);
  return {
    total,
    positionPool: (total * BigInt(availableShareBps)) / BASIS_POINTS,
    tournamentCreator: bps(total, creator),
    gameFee: bps(total, game),
    refund: bps(total, refund),
    protocolFee: bps(total, protocol),
    availableShareBps,
  };
}

/** The on-chain `EntryFee` distribution shape this module needs to size a
 *  position payout. A superset of `EntryFeeSplitInput`. */
export interface EntryFeePositionInput extends EntryFeeSplitInput {
  /** Raw on-chain `Distribution` (any wire shape — parsed internally). */
  distribution: unknown;
  /** Number of paid positions (`distribution_count`). */
  distributionCount: number;
}

/**
 * Amount a single leaderboard `position` (1-indexed) claims from the entry-fee
 * pool. Generalizes the client's `computeEntryFeeAmount` — and fixes its
 * protocol-fee over-count by reserving `protocolFeeShare`.
 *
 * Returns `0n` when the position is outside the paid range, the pool is empty,
 * or the share rounds to zero (the contract makes such positions unclaimable).
 */
export function entryFeePositionPayout(
  input: EntryFeePositionInput,
  position: number,
): bigint {
  const distCount = Number(input.distributionCount ?? 0);
  if (distCount <= 0 || position < 1 || position > distCount) return 0n;

  const split = entryFeeSplit(input);
  if (split.positionPool <= 0n) return 0n;

  const parsed = parseDistribution(input.distribution);
  const spec = toDistributionSpec(parsed, distCount);
  // Exact path: bit-for-bit what `_claim_entry_fee_position` transfers.
  if (spec) return exactPayoutAt(spec, position, distCount, split.positionPool);

  const pcts = distributionPercentages(parsed, distCount);
  const pct = pcts[position - 1] ?? 0;
  if (pct <= 0) return 0n;
  // Carry 4 extra decimals on pct so 0.0001% slices don't vanish (matches client).
  return (split.positionPool * BigInt(Math.floor(pct * 10000))) / 1_000_000n;
}

/**
 * Amount a single `position` (1-indexed) claims from a distributed sponsored
 * ERC20 prize. Generalizes the client's per-position `computePrizePercentages`
 * + amount slicing. Returns `0n` for non-distributed / non-ERC20 prizes, a
 * position outside the paid range, or a zero slice.
 */
export function sponsorPrizePayout(prize: Prize, position: number): bigint {
  if (prize.tokenType !== "erc20") return 0n;
  const distCount = Number(prize.distributionCount ?? 0);
  if (distCount <= 0 || position < 1 || position > distCount) return 0n;

  const pool = BigInt(prize.amount ?? "0");
  const parsed = prizeDistribution(prize);
  const spec = toDistributionSpec(parsed, distCount);
  // Exact path: bit-for-bit what `_claim_distributed_prize` transfers.
  if (spec) return exactPayoutAt(spec, position, distCount, pool);

  const pcts = distributionPercentages(parsed, distCount);
  const pct = pcts[position - 1] ?? 0;
  if (pct <= 0) return 0n;
  return (pool * BigInt(Math.floor(pct * 10000))) / 1_000_000n;
}

// Exact settlement-mirroring maths + authoring-time validation for all six
// curve variants (including Geometric and Tiered).
export {
  MAX_EXACT_EXPONENT,
  maxGeometricPayouts,
  exactPayoutAt,
  exactPayouts,
  payoutPercentages,
  validateDistributionSpec,
  recommendDistribution,
} from "./exact.js";
export type { CurveStyle } from "./exact.js";
export type { DistributionValidation } from "./exact.js";
