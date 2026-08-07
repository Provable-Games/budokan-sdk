import type { Contract } from "starknet";
import { RpcError } from "../errors/index.js";
import { decodeByteArray } from "./decode.js";
import { normalizeAddress } from "../utils/address.js";

// =========================================================================
// Helpers
// =========================================================================

function wrapRpcCall<T>(fn: () => Promise<T>, contractAddress?: string): Promise<T> {
  return fn().catch((error: unknown) => {
    throw new RpcError(
      error instanceof Error ? error.message : "RPC call failed",
      contractAddress,
    );
  });
}

// =========================================================================
// Budokan contract read calls
// =========================================================================

/**
 * Fetch the full Custom distribution shares array for a tournament via the
 * Budokan contract's `tournament_distribution_shares(id)` view.
 *
 * Returns an empty array for tournaments configured with Linear /
 * Exponential / Uniform (those don't have a custom shares array), or for
 * tournaments that aren't configured yet.
 *
 * Consumers going through the primary API path don't need this — the
 * indexer already sources the shares from the `TournamentCreated` event.
 * This is the RPC-fallback path for direct on-chain reads.
 */
export async function budokanTournamentDistributionShares(
  contract: Contract,
  tournamentId: string,
): Promise<number[]> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournament_distribution_shares", [tournamentId]);
    const arr = Array.isArray(result) ? (result as unknown[]) : [];
    return arr.map((v) => Number(v));
  }, contract.address);
}

// =========================================================================
// Protocol-fee terms (Budokan fresh deployment onward)
// =========================================================================
//
// Extension entry fees are custodied by the extension contract, not by
// Budokan — so the protocol fee, refunds, and ultimately the pool itself
// are only as trustworthy as the extension's code. The contract publishes
// its terms instead of gating: `tournament_protocol_fee_info` returns the
// rate snapshotted at creation, the live recipient, and license text
// stating the payment obligation (mirroring game-components' GameFeeInfo).
// Most apps want `getEntryFeeTrust` / `classifyEntryFeeTrust` from
// `extensions/feeTrust`, which turn these into a badge level.

/** Decoded `ProtocolFeeInfo`: the platform's published fee terms. */
export interface ProtocolFeeInfo {
  /** License text stating the payment obligation. */
  license: string;
  /** Basis points of entry-fee revenue owed. */
  feeBps: number;
  /** Address the fee routes to (zero when unset). */
  recipient: string;
}

function decodeProtocolFeeInfo(result: unknown): ProtocolFeeInfo {
  const r = result as { license?: unknown; fee_bps?: unknown; recipient?: unknown };
  return {
    license: decodeByteArray(r?.license),
    feeBps: Number(r?.fee_bps ?? 0),
    recipient: normalizeAddress(
      `0x${BigInt((r?.recipient as string | number | bigint) ?? 0).toString(16)}`,
    ),
  };
}

/**
 * Current global protocol-fee terms: rate + recipient + license in one call.
 * For what a specific tournament owes, use
 * `budokanTournamentProtocolFeeInfo` — rates are snapshotted at creation.
 */
export async function budokanProtocolFeeInfo(
  contract: Contract,
): Promise<ProtocolFeeInfo> {
  return wrapRpcCall(async () => {
    const result = await contract.call("protocol_fee_info", []);
    return decodeProtocolFeeInfo(result);
  }, contract.address);
}

/**
 * A tournament's protocol-fee terms: the bps snapshotted at creation (what
 * this tournament owes), the LIVE recipient (a treasury rotation never
 * strands compliant payments), and the license text. THE integration call
 * for a compliant fee extension.
 */
export async function budokanTournamentProtocolFeeInfo(
  contract: Contract,
  tournamentId: string,
): Promise<ProtocolFeeInfo> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournament_protocol_fee_info", [tournamentId]);
    return decodeProtocolFeeInfo(result);
  }, contract.address);
}

/**
 * The protocol-fee rate (basis points) snapshotted for a tournament at
 * creation. Written for BOTH fee kinds: for BuiltIn fees the contract
 * enforces the cut at claim time; for Extension fees this is the on-chain
 * term a compliant extension is expected to honor.
 */
export async function budokanTournamentProtocolFeeBps(
  contract: Contract,
  tournamentId: string,
): Promise<number> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournament_protocol_fee_bps", [tournamentId]);
    return Number(result);
  }, contract.address);
}

/** The DAO treasury address protocol fees are routed to. */
export async function budokanProtocolFeeRecipient(
  contract: Contract,
): Promise<string> {
  return wrapRpcCall(async () => {
    const result = await contract.call("protocol_fee_recipient", []);
    return normalizeAddress(`0x${BigInt(result as string | number | bigint).toString(16)}`);
  }, contract.address);
}
