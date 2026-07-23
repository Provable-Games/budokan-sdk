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

/**
 * Highest per-leaf count the canonical merkle API can store (signed 32-bit).
 * The on-chain validator accepts the full u32 range, but a leaf count above
 * this registers fine and then breaks proof serving — a tree that can never
 * be entered through budokan.gg. Use this value for "effectively unlimited".
 */
export const MAX_ALLOWLIST_ENTRY_COUNT = 2147483647;

// `NaN < 1` is false, so guard integer-ness explicitly — a fractional/NaN
// count would flow into the on-chain tree leaf.
function assertValidCount(count: number, label: string): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  if (count > MAX_ALLOWLIST_ENTRY_COUNT) {
    throw new Error(
      `${label} must be ≤ ${MAX_ALLOWLIST_ENTRY_COUNT} — larger counts fit the on-chain ` +
        `u32 but the merkle API cannot store them, so proofs would never be served`,
    );
  }
}

/** Turn a uniform-allowance allowlist into merkle entries. */
function toEntries(addresses: string[], entriesPerAddress: number): MerkleEntry[] {
  if (addresses.length === 0) {
    throw new Error("An allowlist needs at least one address");
  }
  assertValidCount(entriesPerAddress, "entriesPerAddress");
  // Normalize to the canonical form and dedupe so representation variants
  // (leading zeros / casing) don't produce redundant leaves, and so the tree
  // agrees with the normalized address used for proof lookup.
  const unique = Array.from(new Set(addresses.map(normalizeAddress)));
  return unique.map((address) => ({ address, count: entriesPerAddress }));
}

/**
 * Validate + normalize tiered per-address entries. Duplicate addresses are an
 * error (rather than last-wins) because two counts for one address is almost
 * always a snapshot bug, and the wrong pick would be silently baked into an
 * immutable tree leaf.
 */
function toTieredEntries(entries: AllowlistEntry[]): MerkleEntry[] {
  if (entries.length === 0) {
    throw new Error("An allowlist needs at least one entry");
  }
  const seen = new Map<string, number>();
  for (const entry of entries) {
    assertValidCount(entry.count, `count for ${entry.address}`);
    const address = normalizeAddress(entry.address);
    const prior = seen.get(address);
    if (prior !== undefined && prior !== entry.count) {
      throw new Error(
        `Duplicate address ${address} with conflicting counts (${prior} vs ${entry.count})`,
      );
    }
    seen.set(address, entry.count);
  }
  return Array.from(seen, ([address, count]) => ({ address, count }));
}

/** One tiered allowlist entry: an address with its own entry allowance. */
export interface AllowlistEntry {
  address: string;
  /** Entry allowance baked into this leaf (1 ≤ count ≤ MAX_ALLOWLIST_ENTRY_COUNT). */
  count: number;
}

interface BuildRegisterAllowlistTreeBase {
  chain: WhitelistChain;
  /** Override the merkle API URL for this chain. */
  apiUrl?: string;
}

/** Uniform allowance: every address gets the same entry count. */
export interface UniformAllowlistParams extends BuildRegisterAllowlistTreeBase {
  /** Addresses allowed to enter, all sharing `entriesPerAddress`. */
  addresses: string[];
  /**
   * Per-address entry allowance baked into the tree leaf (default 1). Note the
   * validator applies `effective = min(count, entry_limit)` when the
   * tournament's `entry_requirement.entryLimit > 0`, so raising this above the
   * tournament's `entryLimit` has no effect — set both consistently. For
   * brackets both are 1.
   */
  entriesPerAddress?: number;
  entries?: never;
}

/** Tiered allowance: each address carries its own entry count. */
export interface TieredAllowlistParams extends BuildRegisterAllowlistTreeBase {
  /**
   * Tiered allowlist: each address with its own allowance (e.g. whales get 5
   * entries, everyone else 1).
   */
  entries: AllowlistEntry[];
  addresses?: never;
  entriesPerAddress?: never;
}

/**
 * Union encodes the `addresses` XOR `entries` invariant at compile time;
 * the runtime guards below keep JS callers honest too.
 */
export type BuildRegisterAllowlistTreeParams = UniformAllowlistParams | TieredAllowlistParams;

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
  // Presence (not truthiness) decides which form the caller chose, so an
  // explicitly-empty `entries: []` fails with the tiered-form message rather
  // than silently falling through to the uniform form.
  const hasEntries = params.entries !== undefined;
  if (hasEntries && params.addresses !== undefined) {
    throw new Error("Provide either `addresses` or `entries`, not both");
  }
  if (hasEntries && params.entriesPerAddress !== undefined) {
    throw new Error("`entriesPerAddress` only applies to `addresses` — set counts inside `entries`");
  }
  const merkleEntries = hasEntries
    ? toTieredEntries(params.entries!)
    : toEntries(params.addresses ?? [], params.entriesPerAddress ?? 1);
  const { call, entries } = merkleClient(params.chain, params.apiUrl).buildRegisterTreeCall(
    merkleEntries,
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
 * Non-throwing eligibility check: the `Span<felt252>` entry proof when the
 * address is on the allowlist, `null` when it isn't. Still throws when the
 * merkle service is unreachable — callers must never render a service outage
 * as "not allowlisted".
 *
 * Prefer this for eligibility UI / status checks; `getAllowlistProof` throws
 * on absence, which suits entry flows where absence is exceptional.
 */
export async function checkAllowlist(params: GetAllowlistProofParams): Promise<string[] | null> {
  const proof = await merkleClient(params.chain, params.apiUrl).getProof(
    params.treeId,
    normalizeAddress(params.address),
  );
  return proof ? proof.qualification : null;
}

/**
 * Fetch the `Span<felt252>` merkle proof for an allowlisted address. Pass the
 * result as `qualification: { kind: "extension", data }` to
 * `buildEnterTournamentCall` (or as the `proof` arg to `bracketEntryCalls`).
 * Throws if the address isn't on the allowlist; propagates a service error if
 * the merkle service is unreachable (rather than reporting "not allowlisted").
 * For a non-throwing eligibility check use `checkAllowlist`.
 */
export async function getAllowlistProof(params: GetAllowlistProofParams): Promise<string[]> {
  // Normalize so the lookup matches the (normalized) address the tree was built
  // with — the service keys proofs by lowercased-but-unpadded address.
  return merkleClient(params.chain, params.apiUrl).getProofSpan(
    params.treeId,
    normalizeAddress(params.address),
  );
}
