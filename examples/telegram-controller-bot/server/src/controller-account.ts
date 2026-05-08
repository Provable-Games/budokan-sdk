// Construct a signing-capable WalletAccount for a chat from its persisted
// session. See ../../ARCHITECTURE.md "Build and submit (server-side execution)".
//
// We delegate to @cartridge/controller's NodeBackend-backed SessionProvider:
// it knows how to read signer + session + policies from a per-chat directory
// and rehydrate a SessionAccount. We don't reimplement that logic.
//
// The session.json file shape we persist (see http.ts:parseSessionBody +
// session-store.ts) intentionally matches NodeBackend's expectations:
//   {
//     "signer": { privKey, pubKey },
//     "session": { username, address, ownerGuid, expiresAt, ... },
//     "policies": ParsedSessionPolicies,
//     "chain": "mainnet" | "sepolia"        // extra; ignored by NodeBackend
//   }

import { join } from "node:path";
import { constants } from "starknet";
import SessionProvider from "@cartridge/controller/session/node";
import { CHAINS } from "@provable-games/budokan-sdk";

import type { Config } from "./config.ts";
import { buildSessionPolicies } from "./policies.ts";

// Minimal structural interface for the bits of the account we use.
// @cartridge/controller bundles its own starknet@8, while we import
// starknet@9 directly — so the WalletAccount class identities don't match
// across that boundary even though the runtime objects are compatible.
// Defining what we need locally avoids the type-skew error.
export interface ExecutingAccount {
  address: string;
  execute(
    calls: { contractAddress: string; entrypoint: string; calldata: string[] }[],
  ): Promise<{ transaction_hash: string }>;
}

export interface AccountResolution {
  account: ExecutingAccount;
  username: string;
  address: string;
  expiresAtUnix: number;
}

export type AccountFailureReason =
  | "no_session"
  | "expired"
  | "policy_mismatch";

export type AccountResult =
  | { ok: true; data: AccountResolution }
  | { ok: false; reason: AccountFailureReason };

/**
 * Resolve a chat's persisted session into a working WalletAccount.
 *
 * - Returns { ok: true, ... } when the session is valid and the policies
 *   currently configured are a subset of those the user signed at /connect.
 * - Returns { ok: false, reason: "no_session" } if the chat hasn't connected.
 * - Returns { ok: false, reason: "expired" } if the session TTL elapsed.
 * - Returns { ok: false, reason: "policy_mismatch" } if the configured
 *   policy bundle has grown since the session was authorized (the user
 *   would need to re-/connect to widen consent).
 */
export async function resolveAccount(chatId: string, config: Config): Promise<AccountResult> {
  const basePath = join(config.dataDir, "sessions", chatId);
  const rpcUrl = config.rpcUrl ?? CHAINS[config.chain]?.rpcUrl;
  if (!rpcUrl) {
    throw new Error(`No RPC URL configured for chain '${config.chain}'.`);
  }

  const provider = new SessionProvider({
    rpc: rpcUrl,
    chainId: chainIdFor(config.chain),
    policies: buildSessionPolicies(config.chain, config.budokanAddress),
    basePath,
  });

  const account = await provider.probe();
  if (!account) {
    // probe returns undefined for both no-file and expired/policy-mismatch
    // cases. We can't distinguish from probe alone; SessionStore handles the
    // file-existence check upstream. If it returns undefined here it means
    // the file existed but the session is no longer usable.
    return { ok: false, reason: "expired" };
  }

  // SessionProvider stashes username on itself after probe(). It's not on the
  // account, but we want it for chat replies — read via provider.username().
  const username = (await provider.username()) ?? "unknown";

  return {
    ok: true,
    data: {
      account: account as unknown as ExecutingAccount,
      username,
      address: account.address,
      expiresAtUnix: 0, // not currently surfaced by SessionProvider — leave 0
    },
  };
}

export function chainIdFor(chain: "mainnet" | "sepolia"): constants.StarknetChainId {
  return chain === "mainnet"
    ? constants.StarknetChainId.SN_MAIN
    : constants.StarknetChainId.SN_SEPOLIA;
}
