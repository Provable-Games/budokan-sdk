/**
 * Merkle allowlist helpers — app-agnostic wrappers over the metagame-sdk
 * `MerkleClient` for the deployed budokan merkle validator.
 *
 * These let any consumer (web client, Telegram, Discord) gate a tournament on
 * an address allowlist without re-implementing the merkle plumbing. As with
 * the rest of the SDK, the signing step is left to the caller: creating a tree
 * is a two-step, on-chain flow, so we return the registration `Call` rather
 * than signing it.
 *
 *   1. `buildRegisterAllowlistTreeCall({ chain, addresses })`
 *        → `{ call, entries }`. The caller signs/executes `call` (registers the
 *          tree on the merkle validator, which assigns it an id).
 *   2. `parseAllowlistTreeId({ chain, events })`
 *        → the `treeId` from the transaction receipt's events.
 *   3. `storeAllowlistTree({ chain, treeId, name, description, entries })`
 *        → persists the tree in the merkle API so proofs can be served.
 *   4. `getAllowlistProof({ chain, treeId, address })`
 *        → the `Span<felt252>` proof to pass as `qualification` when entering.
 *
 * Pair `treeId` with `buildMerkleConfig({ treeId })` + `extensionAddressFor(
 * chain, "merkle")` to build the tournament's `entry_requirement`. See
 * `src/brackets/index.ts` (`roundOneTreeIds`) for the bracket integration.
 *
 * Note: the merkle proof format (`getAllowlistProof` returns the API's
 * `qualification` span, i.e. `[count, ...proof]`) should be verified end-to-end
 * on sepolia against the deployed validator's `validate_entry` before relying
 * on it in production — see the plan's open decisions.
 */

import { MerkleClient, type MerkleEntry } from "@provable-games/metagame-sdk/merkle";
import type { Call } from "../calldata/index.js";
import type { WhitelistChain } from "../games/whitelist.js";
import { extensionAddressFor } from "./index.js";

/** Map our short chain names to the chain IDs metagame-sdk uses. */
function sdkChainId(chain: WhitelistChain): string {
  return chain === "mainnet" ? "SN_MAIN" : "SN_SEPOLIA";
}

function merkleClient(chain: WhitelistChain, apiUrl?: string): MerkleClient {
  return new MerkleClient({ chainId: sdkChainId(chain), ...(apiUrl ? { apiUrl } : {}) });
}

/** Turn an allowlist into merkle entries, each with a per-address entry count. */
function toEntries(addresses: string[], entriesPerAddress: number): MerkleEntry[] {
  if (addresses.length === 0) {
    throw new Error("An allowlist needs at least one address");
  }
  if (entriesPerAddress < 1) {
    throw new Error("entriesPerAddress must be ≥ 1");
  }
  return addresses.map((address) => ({ address, count: entriesPerAddress }));
}

export interface BuildRegisterAllowlistTreeParams {
  chain: WhitelistChain;
  /** Addresses allowed to enter. */
  addresses: string[];
  /**
   * Per-address entry allowance baked into the tree leaf (default 1). Note the
   * validator applies `effective = min(count, entry_limit)` when the
   * tournament's `entry_requirement.entryLimit > 0`, so raising this above the
   * tournament's `entryLimit` has no effect — set both consistently. For
   * brackets both are 1.
   */
  entriesPerAddress?: number;
  /** Override the merkle API URL for this chain. */
  apiUrl?: string;
}

export interface RegisterAllowlistTreeResult {
  /** On-chain `create_tree` call for the caller to sign against the validator. */
  call: Call;
  /**
   * The tree entries — pass these back to `storeAllowlistTree` (with the
   * `treeId` parsed from the receipt) so the API can serve proofs.
   */
  entries: MerkleEntry[];
}

/**
 * Build the on-chain call that registers an address allowlist as a merkle tree
 * on the deployed merkle validator. Local/pure (no network) — the caller signs
 * the returned `call`, then reads the assigned `treeId` from the receipt via
 * `parseAllowlistTreeId` and persists the tree via `storeAllowlistTree`.
 */
export function buildRegisterAllowlistTreeCall(
  params: BuildRegisterAllowlistTreeParams,
): RegisterAllowlistTreeResult {
  const validator = extensionAddressFor(params.chain, "merkle");
  const entries = toEntries(params.addresses, params.entriesPerAddress ?? 1);
  const { call } = merkleClient(params.chain, params.apiUrl).buildTreeCalldata(
    entries,
    validator,
  );
  return { call: { ...call }, entries };
}

export interface ParseAllowlistTreeIdParams {
  chain: WhitelistChain;
  /** The `events` array from the register-tree transaction receipt. */
  events: unknown[];
  apiUrl?: string;
}

/**
 * Parse the tree id assigned on-chain from the register-tree receipt events.
 * Returns null if the validator's tree-created event can't be found.
 */
export function parseAllowlistTreeId(params: ParseAllowlistTreeIdParams): number | null {
  const validator = extensionAddressFor(params.chain, "merkle");
  return merkleClient(params.chain, params.apiUrl).parseTreeIdFromEvents(
    params.events as unknown[],
    validator,
  );
}

export interface StoreAllowlistTreeParams {
  chain: WhitelistChain;
  /** Tree id assigned on-chain (from `parseAllowlistTreeId`). */
  treeId: number;
  name: string;
  description: string;
  /** The entries returned by `buildRegisterAllowlistTreeCall`. */
  entries: MerkleEntry[];
  apiUrl?: string;
}

/**
 * Persist a registered tree in the merkle API so proofs can be served for it.
 * Call after the register-tree transaction is confirmed and `treeId` is known.
 */
export async function storeAllowlistTree(params: StoreAllowlistTreeParams): Promise<void> {
  await merkleClient(params.chain, params.apiUrl).createTree({
    treeId: params.treeId,
    name: params.name,
    description: params.description,
    entries: params.entries,
  });
}

export interface GetAllowlistProofParams {
  chain: WhitelistChain;
  treeId: number | string;
  address: string;
  apiUrl?: string;
}

/**
 * Fetch the `Span<felt252>` merkle proof for an allowlisted address. Pass the
 * result as `qualification: { kind: "extension", data }` to
 * `buildEnterTournamentCall` (or as the `proof` arg to `bracketEntryCalls`).
 * Throws if the address isn't in the tree.
 */
export async function getAllowlistProof(params: GetAllowlistProofParams): Promise<string[]> {
  const res = await merkleClient(params.chain, params.apiUrl).getProof(
    params.treeId,
    params.address,
  );
  if (!res) {
    throw new Error(
      `No merkle proof for ${params.address} in tree ${params.treeId} (not on the allowlist, or the tree isn't stored yet).`,
    );
  }
  return res.qualification;
}
