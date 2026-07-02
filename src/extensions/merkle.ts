/**
 * Merkle allowlist helpers for budokan brackets.
 *
 * These are thin, budokan-flavored adapters over `@provable-games/metagame-sdk`'s
 * `MerkleClient` — they map budokan's short chain names (`"mainnet"`/`"sepolia"`)
 * to the SDK's chain ids and keep the same call-returning shape as the rest of
 * this SDK. The generic merkle logic (validator address lookup, the on-chain
 * `create_tree` call, proof serving, service-error handling) lives in
 * metagame-sdk so any app gating a contract on an allowlist can reuse it.
 *
 * As with the rest of the SDK the signing step is the caller's: creating a tree
 * is a two-step on-chain flow, so `buildRegisterAllowlistTreeCall` returns the
 * registration `Call` rather than signing it.
 *
 *   1. `buildRegisterAllowlistTreeCall({ chain, addresses })` → `{ call, entries }`
 *   2. sign/execute `call` (registers the tree; the validator assigns an id)
 *   3. `parseAllowlistTreeId({ chain, events })` → the `treeId` from the receipt
 *   4. `storeAllowlistTree({ chain, treeId, name, description, entries })`
 *   5. `getAllowlistProof({ chain, treeId, address })` → the proof span to enter
 *
 * Pair `treeId` with `buildMerkleConfig({ treeId })` + `extensionAddressFor(
 * chain, "merkle")` to build the tournament's `entry_requirement`.
 */

import { createMerkleClient, type MerkleEntry } from "@provable-games/metagame-sdk/merkle";
import type { Call } from "../calldata/index.js";
import type { WhitelistChain } from "../games/whitelist.js";
import { normalizeAddress } from "../utils/address.js";

/** Map our short chain names to the chain IDs metagame-sdk uses. */
function sdkChainId(chain: WhitelistChain): string {
  return chain === "mainnet" ? "SN_MAIN" : "SN_SEPOLIA";
}

function merkleClient(chain: WhitelistChain, apiUrl?: string) {
  return createMerkleClient({ chainId: sdkChainId(chain), ...(apiUrl ? { apiUrl } : {}) });
}

/** Turn an allowlist into merkle entries, each with a per-address entry count. */
function toEntries(addresses: string[], entriesPerAddress: number): MerkleEntry[] {
  if (addresses.length === 0) {
    throw new Error("An allowlist needs at least one address");
  }
  // `NaN < 1` is false, so guard integer-ness explicitly — a fractional/NaN
  // count would flow into the on-chain tree leaf.
  if (!Number.isInteger(entriesPerAddress) || entriesPerAddress < 1) {
    throw new Error("entriesPerAddress must be a positive integer");
  }
  // Normalize to the canonical form and dedupe so representation variants
  // (leading zeros / casing) don't produce redundant leaves, and so the tree
  // agrees with the normalized address used for proof lookup.
  const unique = Array.from(new Set(addresses.map(normalizeAddress)));
  return unique.map((address) => ({ address, count: entriesPerAddress }));
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
  const { call, entries } = merkleClient(params.chain, params.apiUrl).buildRegisterTreeCall(
    toEntries(params.addresses, params.entriesPerAddress ?? 1),
  );
  return { call: { ...call, calldata: [...call.calldata] }, entries };
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
  return merkleClient(params.chain, params.apiUrl).parseTreeIdFromEvents(
    params.events as unknown[],
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
 * Throws if the address isn't on the allowlist; propagates a service error if
 * the merkle service is unreachable (rather than reporting "not allowlisted").
 */
export async function getAllowlistProof(params: GetAllowlistProofParams): Promise<string[]> {
  // Normalize so the lookup matches the (normalized) address the tree was built
  // with — the service keys proofs by lowercased-but-unpadded address.
  return merkleClient(params.chain, params.apiUrl).getProofSpan(
    params.treeId,
    normalizeAddress(params.address),
  );
}
