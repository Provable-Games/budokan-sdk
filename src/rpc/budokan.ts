import type { Contract } from "starknet";
import { RpcError } from "../errors/index.js";

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
// Fee-extension trust reads (Budokan fresh deployment onward)
// =========================================================================
//
// Extension entry fees are custodied by the extension contract, not by
// Budokan — so the protocol fee, refunds, and ultimately the pool itself
// are only as trustworthy as the extension's code. Budokan keeps an
// owner-governed on-chain registry of vetted fee extensions, plus a gating
// flag: while gating is disabled (the deployment default) the registry is
// advisory and creation stays permissionless; when enabled,
// `create_tournament` refuses unapproved fee extensions outright.
//
// These reads are the raw registry surface. Most apps want
// `getEntryFeeTrust` / `classifyEntryFeeTrust` from `extensions/feeTrust`,
// which turn them into a badge level.

/** Whether `extension` is in Budokan's vetted fee-extension registry. */
export async function budokanIsFeeExtensionApproved(
  contract: Contract,
  extensionAddress: string,
): Promise<boolean> {
  return wrapRpcCall(async () => {
    const result = await contract.call("is_fee_extension_approved", [extensionAddress]);
    return Boolean(result);
  }, contract.address);
}

/**
 * Whether the registry is enforced at `create_tournament` (true), or
 * advisory only (false — the permissionless deployment default).
 */
export async function budokanFeeExtensionGatingEnabled(
  contract: Contract,
): Promise<boolean> {
  return wrapRpcCall(async () => {
    const result = await contract.call("fee_extension_gating_enabled", []);
    return Boolean(result);
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
    return `0x${BigInt(result as string | number | bigint).toString(16)}`;
  }, contract.address);
}
