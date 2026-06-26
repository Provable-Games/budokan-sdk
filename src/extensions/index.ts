/**
 * Entry-requirement validator extensions.
 *
 * Thin wrappers on top of @provable-games/metagame-sdk for the four
 * validator presets we recommend for chat / bot integrations:
 *
 *   - merkle           — Allowlist of addresses via a pre-built merkle tree
 *   - erc20Balance     — Player must hold ≥ X of some ERC-20
 *   - opusTroves       — Player must have borrowed ≥ $X CASH on Opus
 *   - tournament       — Player must have entered / placed in a prior tournament
 *
 * Each `buildXxxConfig` function emits the `Span<felt252>` config array
 * the on-chain validator's `add_config` expects. Pair the array with the
 * validator address (via `extensionAddressFor`) when building an
 * `EntryRequirementArgs` of kind `"extension"`.
 *
 * Authoritative on-chain layouts:
 *   metagame-extensions/packages/presets/src/entry_requirement/*.cairo
 *
 * u256 values (ERC-20 balance thresholds) are split into low/high felt
 * pairs to match those layouts. CASH amounts for Opus are passed as
 * single felts because they're u128-range in practice.
 */

import { getExtensionAddresses } from "@provable-games/metagame-sdk";
import type { WhitelistChain } from "../games/whitelist.js";

export type ExtensionPresetKind =
  | "merkle"
  | "erc20Balance"
  | "opusTroves"
  | "tournament";

/** Map our short chain names to the chain IDs metagame-sdk uses. */
function sdkChainId(chain: WhitelistChain): string {
  return chain === "mainnet" ? "SN_MAIN" : "SN_SEPOLIA";
}

/**
 * Lookup the deployed validator address for a given preset on a given
 * chain. Throws if the metagame-sdk address table doesn't have one — the
 * preset isn't usable on that chain.
 */
export function extensionAddressFor(
  chain: WhitelistChain,
  kind: ExtensionPresetKind,
): string {
  const table = getExtensionAddresses(sdkChainId(chain));
  switch (kind) {
    case "merkle":
      if (!table.merkleValidator)
        throw new Error(`No merkleValidator address for ${chain}`);
      return table.merkleValidator;
    case "erc20Balance":
      if (!table.erc20BalanceValidator)
        throw new Error(`No erc20BalanceValidator address for ${chain}`);
      return table.erc20BalanceValidator;
    case "opusTroves":
      if (!table.opusTrovesValidator)
        throw new Error(`No opusTrovesValidator address for ${chain}`);
      return table.opusTrovesValidator;
    case "tournament":
      if (!table.tournamentValidator)
        throw new Error(`No tournamentValidator address for ${chain}`);
      return table.tournamentValidator;
  }
}

const U256_MAX = (1n << 256n) - 1n;

/** Split a u256 (as bigint) into [low_128, high_128] felt strings. */
export function u256ToLowHigh(value: bigint): [string, string] {
  if (value < 0n) throw new Error("u256 cannot be negative");
  if (value > U256_MAX)
    throw new Error(`Value exceeds u256 max: ${value.toString()}`);
  const MASK = (1n << 128n) - 1n;
  return [(value & MASK).toString(), (value >> 128n).toString()];
}

// ---------------------------------------------------------------------------
// ERC20 balance config
// ---------------------------------------------------------------------------

export interface Erc20BalanceConfig {
  tokenAddress: string;
  /** Raw u256, smallest units. */
  minThreshold: bigint;
  /** Raw u256, smallest units; 0 = no max. */
  maxThreshold: bigint;
  /** Raw u256, smallest units; 0 = single entry, regardless of balance. */
  valuePerEntry: bigint;
  /** 0 = unlimited (only meaningful when valuePerEntry > 0). */
  maxEntries: number;
  bannable: boolean;
}

/**
 * Build the felt-string config array.
 *
 * Layout (from erc20_balance_validator.cairo):
 *   [token, min_low, min_high, max_low, max_high, vpe_low, vpe_high,
 *    max_entries, bannable]
 */
export function buildErc20BalanceConfig(cfg: Erc20BalanceConfig): string[] {
  const [minLo, minHi] = u256ToLowHigh(cfg.minThreshold);
  const [maxLo, maxHi] = u256ToLowHigh(cfg.maxThreshold);
  const [vpeLo, vpeHi] = u256ToLowHigh(cfg.valuePerEntry);
  return [
    cfg.tokenAddress,
    minLo, minHi,
    maxLo, maxHi,
    vpeLo, vpeHi,
    String(cfg.maxEntries),
    cfg.bannable ? "1" : "0",
  ];
}

// ---------------------------------------------------------------------------
// Opus Troves config
// ---------------------------------------------------------------------------

export interface OpusTrovesConfig {
  /** Specific collateral filters; empty = wildcard (any trove qualifies). */
  assetAddresses: string[];
  /** Min CASH borrowed (raw, 18 decimals). CASH is 1:1 USD. */
  threshold: bigint;
  /** CASH per additional entry; 0 = single entry per qualifying trove. */
  valuePerEntry: bigint;
  /** 0 = unlimited (only meaningful with proportional valuePerEntry > 0). */
  maxEntries: number;
  bannable: boolean;
}

/**
 * Layout (from opus_troves_validator):
 *   [asset_count, ...asset_addresses, threshold, value_per_entry,
 *    max_entries, bannable]
 *
 * threshold / value_per_entry are CASH amounts (18 decimals, ≤ u128 range
 * for any reasonable USD value) — passed as single felts, not low/high
 * pairs. This matches the validator's parse (parseOpusTrovesValidatorConfig
 * in metagame-sdk reads them as bigints directly).
 */
export function buildOpusTrovesConfig(cfg: OpusTrovesConfig): string[] {
  return [
    String(cfg.assetAddresses.length),
    ...cfg.assetAddresses,
    cfg.threshold.toString(),
    cfg.valuePerEntry.toString(),
    String(cfg.maxEntries),
    cfg.bannable ? "1" : "0",
  ];
}

// ---------------------------------------------------------------------------
// Merkle config
// ---------------------------------------------------------------------------

export interface MerkleConfig {
  /** On-chain tree ID from the merkle-validator's create_tree. */
  treeId: number;
}

/** Layout: [tree_id]. */
export function buildMerkleConfig(cfg: MerkleConfig): string[] {
  return [String(cfg.treeId)];
}

// ---------------------------------------------------------------------------
// Tournament participation config
// ---------------------------------------------------------------------------

/** 0 = participated (any entry counts), 1 = won (placed in top N). */
export type TournamentRequirementType = "participated" | "won";

/**
 * How to combine multiple qualifying tournaments. Matches QualifyingMode
 * in metagame-sdk: 0=AtLeastOne, 1=CumulativePerTournament, 2=All,
 * 3=CumulativePerEntry, 4=AllParticipateAnyWin, 5=AllWithCumulative.
 */
export interface TournamentValidatorConfig {
  requirement: TournamentRequirementType;
  /** Tournament IDs whose history qualifies. */
  tournamentIds: string[];
  /** Top N positions that count (only used when requirement = "won"). */
  topPositions: number;
  /** Default 0 (= AtLeastOne). */
  qualifyingMode?: number;
}

/**
 * Layout (from tournament_validator):
 *   [qualifier_type, qualifying_mode, top_positions, ...tournament_ids]
 *   - qualifier_type: 0 = participated, 1 = won
 *   - qualifying_mode: 0–5 enum
 *   - top_positions: 0 for "all positions" (used with participated)
 */
export function buildTournamentValidatorConfig(
  cfg: TournamentValidatorConfig,
): string[] {
  const qualifierType = cfg.requirement === "won" ? "1" : "0";
  const qualifyingMode = String(cfg.qualifyingMode ?? 0);
  const topPositions =
    cfg.requirement === "won" ? String(cfg.topPositions) : "0";
  return [qualifierType, qualifyingMode, topPositions, ...cfg.tournamentIds];
}

/**
 * Build the `QualificationProof::Extension` span an entrant passes to
 * `enter_tournament` to prove they satisfy a tournament-validator
 * entry_requirement — i.e. that `tokenId` placed at `position` in
 * `qualifyingTournamentId` (one of the validator's allowed tournaments).
 *
 * Layout (from tournament_validator's qualification check):
 *   [qualifying_tournament_id, token_id, position]
 *
 * Pass the result as `qualification: { kind: "extension", data }` to
 * `buildEnterTournamentCall`. For a 1v1 bracket, `position` is 1 (the match
 * winner) and `qualifyingTournamentId` is the feeder match the entrant won.
 */
export function buildTournamentQualificationProof(
  qualifyingTournamentId: string,
  tokenId: string,
  position: number,
): string[] {
  return [qualifyingTournamentId, tokenId, String(position)];
}
