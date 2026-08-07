/**
 * Entry-fee trust classification.
 *
 * Budokan supports two kinds of entry fee, with very different trust
 * properties:
 *
 * - **BuiltIn** — Budokan custodies the pool, enforces the share waterfall
 *   (creator / game / refund / protocol) at claim time, and the protocol fee
 *   is taken by the contract itself. Trust is the audited core contract.
 *
 * - **Extension** — an external contract collects, custodies, and pays out
 *   the fees; Budokan is a pure dispatcher. The pool, refunds, and the
 *   protocol fee are all only as good as the extension's code. The contract
 *   deliberately does NOT gate these (unenforceable rules shouldn't wear
 *   enforcement costumes on-chain); instead it publishes its terms — rate,
 *   recipient, and license text — via `tournament_protocol_fee_info`, and
 *   vetting lives here, in a curated per-chain list.
 *
 * This module turns that into a badge any app can show next to a
 * tournament's entry fee. It is deliberately structural about its inputs —
 * pass fields from the Budokan API row, the indexer, or an on-chain read;
 * nothing here depends on a specific datasource.
 */

import type { Contract } from "starknet";
import { budokanTournamentProtocolFeeInfo } from "../rpc/budokan.js";

/**
 * Curated fee-extension vetting, per chain (keys match `CHAINS`). An address
 * belongs here after its custody, refund, and protocol-fee-honoring behavior
 * has been reviewed. Empty until the first extension passes review.
 */
export const VETTED_FEE_EXTENSIONS: Record<string, readonly string[]> = {
  mainnet: [],
  sepolia: [],
};

/** Address-normalized membership test against the curated list. */
export function isVettedFeeExtension(
  extensionAddress: string,
  vettedList: readonly string[],
): boolean {
  let target: bigint;
  try {
    target = BigInt(extensionAddress);
  } catch {
    return false;
  }
  return vettedList.some((addr) => {
    try {
      return BigInt(addr) === target;
    } catch {
      return false;
    }
  });
}

/** Trust level of a tournament's entry-fee handling. */
export type EntryFeeTrustLevel =
  /** No entry fee configured. */
  | "none"
  /** BuiltIn fee: Budokan-custodied, waterfall and protocol fee contract-enforced. */
  | "custodial"
  /** Extension fee whose contract is in the curated vetted list. */
  | "vetted-extension"
  /** Extension fee outside the vetted list — extension code is the only guarantee. */
  | "unvetted-extension";

export interface EntryFeeTrust {
  level: EntryFeeTrustLevel;
  /** The fee-extension contract, when the fee is extension-handled. */
  extensionAddress?: string;
  /**
   * Whether the protocol fee on this tournament is enforced by the Budokan
   * contract itself (BuiltIn) or honored by extension convention (Extension).
   * For `none` there is no fee, so nothing to enforce.
   */
  protocolFeeEnforcedOnChain: boolean;
}

export interface ClassifyEntryFeeTrustInput {
  /** Whether the tournament has any entry fee at all. */
  hasEntryFee: boolean;
  /**
   * The fee-extension contract address, if the fee is extension-handled.
   * Null/undefined means a BuiltIn fee. Matches the Budokan API's
   * `entryFeeExtensionAddress` column.
   */
  extensionAddress?: string | null;
  /**
   * Curated-list verdict for `extensionAddress` (ignored for BuiltIn fees).
   * Compute with `isVettedFeeExtension` against `VETTED_FEE_EXTENSIONS`
   * (or your own list).
   */
  extensionVetted?: boolean;
}

/**
 * Pure classification — no network. Feed it fields from wherever you already
 * have them (API row + the curated list).
 */
export function classifyEntryFeeTrust(
  input: ClassifyEntryFeeTrustInput,
): EntryFeeTrust {
  if (!input.hasEntryFee) {
    return { level: "none", protocolFeeEnforcedOnChain: false };
  }

  if (!input.extensionAddress) {
    return { level: "custodial", protocolFeeEnforcedOnChain: true };
  }

  return {
    level: input.extensionVetted ? "vetted-extension" : "unvetted-extension",
    extensionAddress: input.extensionAddress,
    // Extension custody: the contract cannot skim what it never holds; the
    // fee is honored by the extension per the on-chain terms, not enforced.
    protocolFeeEnforcedOnChain: false,
  };
}

/** `EntryFeeTrust` plus the tournament's on-chain protocol-fee terms. */
export interface EntryFeeTrustReport extends EntryFeeTrust {
  /** Snapshotted protocol-fee rate for this tournament, in basis points. */
  protocolFeeBps: number;
  /** DAO treasury the fee routes to (zero address when unset). Read live. */
  protocolFeeRecipient: string;
  /**
   * The on-chain license text stating the payment obligation — Budokan's
   * `default_protocol_fee_license()` unless the owner has set custom terms.
   * Surface this next to an unvetted-extension warning: it is the platform's
   * published expectation of the extension.
   */
  protocolFeeLicense: string;
}

export interface GetEntryFeeTrustOptions {
  /**
   * Override the vetted list (defaults to `VETTED_FEE_EXTENSIONS[chain]`,
   * or the union of all chains' lists when no `chain` is given).
   */
  vettedExtensions?: readonly string[];
  /** Chain key into `VETTED_FEE_EXTENSIONS` (e.g. "mainnet", "sepolia"). */
  chain?: string;
}

/**
 * One-call trust report for a tournament: a single
 * `tournament_protocol_fee_info` read supplies rate + recipient + license,
 * and the curated list supplies the vetting verdict.
 *
 * `contract` is a Budokan `Contract` (see `createContract` +
 * `abis/budokan.json`). The info view exists from the fresh deployment
 * onward; against an older deployment the read rejects with `RpcError`.
 */
export async function getEntryFeeTrust(
  contract: Contract,
  tournament: {
    tournamentId: string;
    hasEntryFee: boolean;
    extensionAddress?: string | null;
  },
  options: GetEntryFeeTrustOptions = {},
): Promise<EntryFeeTrustReport> {
  const info = await budokanTournamentProtocolFeeInfo(
    contract,
    tournament.tournamentId,
  );

  const vettedList =
    options.vettedExtensions ??
    (options.chain
      ? (VETTED_FEE_EXTENSIONS[options.chain] ?? [])
      : Object.values(VETTED_FEE_EXTENSIONS).flat());

  return {
    ...classifyEntryFeeTrust({
      hasEntryFee: tournament.hasEntryFee,
      extensionAddress: tournament.extensionAddress,
      extensionVetted: tournament.extensionAddress
        ? isVettedFeeExtension(tournament.extensionAddress, vettedList)
        : false,
    }),
    protocolFeeBps: info.feeBps,
    protocolFeeRecipient: info.recipient,
    protocolFeeLicense: info.license,
  };
}
