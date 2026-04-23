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
