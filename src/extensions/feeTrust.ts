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
 *   protocol fee are all only as good as the extension's code. Budokan keeps
 *   an owner-governed on-chain registry of vetted fee extensions so this
 *   trust difference is legible.
 *
 * This module turns that into a badge any app can show next to a
 * tournament's entry fee. It is deliberately structural about its inputs —
 * pass fields from the Budokan API row, the indexer, or an on-chain read;
 * nothing here depends on a specific datasource.
 */

import type { Contract } from "starknet";
import {
  budokanFeeExtensionGatingEnabled,
  budokanIsFeeExtensionApproved,
  budokanProtocolFeeRecipient,
  budokanTournamentProtocolFeeBps,
} from "../rpc/budokan.js";

/** Trust level of a tournament's entry-fee handling. */
export type EntryFeeTrustLevel =
  /** No entry fee configured. */
  | "none"
  /** BuiltIn fee: Budokan-custodied, waterfall and protocol fee contract-enforced. */
  | "custodial"
  /** Extension fee whose contract is in Budokan's vetted registry. */
  | "vetted-extension"
  /** Extension fee whose contract is NOT in the registry — extension code is the only guarantee. */
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
  /**
   * True when Budokan is currently refusing unapproved fee extensions at
   * creation. An `unvetted-extension` tournament can only exist from before
   * gating was enabled (or while it is off).
   */
  gatingEnabled: boolean;
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
  /** Registry verdict for `extensionAddress` (ignored for BuiltIn fees). */
  extensionApproved?: boolean;
  /** Current gating state (advisory registry vs hard allowlist). */
  gatingEnabled?: boolean;
}

/**
 * Pure classification — no network. Feed it fields from wherever you already
 * have them (API row + a cached registry read).
 */
export function classifyEntryFeeTrust(
  input: ClassifyEntryFeeTrustInput,
): EntryFeeTrust {
  const gatingEnabled = input.gatingEnabled ?? false;

  if (!input.hasEntryFee) {
    return { level: "none", protocolFeeEnforcedOnChain: false, gatingEnabled };
  }

  if (!input.extensionAddress) {
    return {
      level: "custodial",
      protocolFeeEnforcedOnChain: true,
      gatingEnabled,
    };
  }

  return {
    level: input.extensionApproved ? "vetted-extension" : "unvetted-extension",
    extensionAddress: input.extensionAddress,
    // Extension custody: the contract cannot skim what it never holds; the
    // fee is honored by the extension per the on-chain terms, not enforced.
    protocolFeeEnforcedOnChain: false,
    gatingEnabled,
  };
}

/** `EntryFeeTrust` plus the tournament's on-chain protocol-fee terms. */
export interface EntryFeeTrustReport extends EntryFeeTrust {
  /** Snapshotted protocol-fee rate for this tournament, in basis points. */
  protocolFeeBps: number;
  /** DAO treasury the fee routes to (zero address when unset). */
  protocolFeeRecipient: string;
}

/**
 * One-call trust report for a tournament, reading the registry and the
 * tournament's protocol-fee terms over RPC.
 *
 * `contract` is a Budokan `Contract` (see `createContract` +
 * `abis/budokan.json`). Registry views exist from the fresh deployment
 * onward; against an older deployment the reads reject with `RpcError`.
 */
export async function getEntryFeeTrust(
  contract: Contract,
  tournament: {
    tournamentId: string;
    hasEntryFee: boolean;
    extensionAddress?: string | null;
  },
): Promise<EntryFeeTrustReport> {
  const [gatingEnabled, protocolFeeBps, protocolFeeRecipient, extensionApproved] =
    await Promise.all([
      budokanFeeExtensionGatingEnabled(contract),
      budokanTournamentProtocolFeeBps(contract, tournament.tournamentId),
      budokanProtocolFeeRecipient(contract),
      tournament.extensionAddress
        ? budokanIsFeeExtensionApproved(contract, tournament.extensionAddress)
        : Promise.resolve(false),
    ]);

  return {
    ...classifyEntryFeeTrust({
      hasEntryFee: tournament.hasEntryFee,
      extensionAddress: tournament.extensionAddress,
      extensionApproved,
      gatingEnabled,
    }),
    protocolFeeBps,
    protocolFeeRecipient,
  };
}
