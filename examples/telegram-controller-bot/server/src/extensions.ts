// Entry-requirement validator extensions.
//
// Mirrors the deployed-addresses table in
// `metagame-sdk/src/utils/extensions.ts` (source of truth) and adds chat-
// shaped preset definitions for the four validators we let chat users pick
// in /create:
//
//   - merkle           — Allowlist of addresses via a pre-built merkle tree
//   - erc20Balance     — Player must hold ≥ X of some ERC-20
//   - opusTroves       — Player must have borrowed ≥ $X CASH on Opus
//   - tournament       — Player must have entered / placed in a prior tournament
//
// Each preset knows how to build the `Span<felt252>` config array its
// on-chain validator expects (see
// metagame-extensions/packages/presets/src/entry_requirement/* for the
// authoritative layouts). u256 values are split into low/high felt pairs.
//
// Addresses kept in sync by hand. If we add a metagame-sdk dependency to
// the bot we should swap this out for `getExtensionAddresses()`.

import type { Chain } from "./chat-state.ts";

export type ExtensionPresetKind =
  | "merkle"
  | "erc20Balance"
  | "opusTroves"
  | "tournament";

export interface ExtensionAddresses {
  tournamentValidator: string;
  erc20BalanceValidator: string;
  opusTrovesValidator: string;
  merkleValidator: string;
}

// Mainnet + sepolia from metagame-sdk/src/utils/extensions.ts.
const ADDRESSES: Record<Chain, ExtensionAddresses> = {
  mainnet: {
    tournamentValidator:
      "0x03b8a0c224dc393b8ea8dd51fe691b298977b27bf9926e01dc37ccbb7e25bd40",
    erc20BalanceValidator:
      "0x05b46bedc2134e6e5bb4b28301fd03bb6c8ccc33bd63cd831230ed8f16f460a9",
    opusTrovesValidator:
      "0x0391111c6c51a83e8ab3bf3c632377424c76e42cff571ac2f2c424e6077f49a3",
    merkleValidator:
      "0x0570d41b66f0eea3c342d570e456e51194817b8eb563dc580c63c2f3d6e505ec",
  },
  sepolia: {
    tournamentValidator:
      "0x062b54188ee532026d3151e564db8668b3587266c8c73ad2fef68c19bfd3e57e",
    erc20BalanceValidator:
      "0x0717524e75b53bfa3ebfb0a16014d4e6b873a22d0e979d1bcd0a3f41bd0e3523",
    opusTrovesValidator:
      "0x05c75a4a48f1fe37cdd49766a2b4317f4ae57e87504ac8879f150c0686490e59",
    merkleValidator:
      "0x0094393c9516f3a0cb16fd56aaa558d94c2da20a2f5074fd15e6f2624b5daf43",
  },
};

export function extensionAddressFor(
  chain: Chain,
  kind: ExtensionPresetKind,
): string {
  const table = ADDRESSES[chain];
  switch (kind) {
    case "merkle":
      return table.merkleValidator;
    case "erc20Balance":
      return table.erc20BalanceValidator;
    case "opusTroves":
      return table.opusTrovesValidator;
    case "tournament":
      return table.tournamentValidator;
  }
}

/** Split a u256 (as bigint) into [low_128, high_128] felt strings. */
export function u256ToLowHigh(value: bigint): [string, string] {
  if (value < 0n) throw new Error("u256 cannot be negative");
  const MASK = (1n << 128n) - 1n;
  return [(value & MASK).toString(), (value >> 128n).toString()];
}

/** Parse a decimal string to bigint. Throws on invalid input. */
export function parseDecimalToBigint(input: string): bigint {
  const t = input.trim();
  if (!/^\d+$/.test(t)) throw new Error(`Not a non-negative integer: ${input}`);
  return BigInt(t);
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
 * Build felt-string config array.
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
 * We expose only AtLeastOne in chat (the sensible default).
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
