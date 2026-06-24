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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { constants } from "starknet";
import SessionProvider from "@cartridge/controller/session/node";

import type { Config } from "./config.ts";
import type { Chain } from "./chat-state.ts";
import { buildSessionPolicies } from "./policies.ts";
import { keychainSafeRpcUrl } from "./cartridge-link.ts";

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
  // Present on the underlying WalletAccount; used to sequence multi-tx flows
  // (claim/distribute batches) so a later execute doesn't race the nonce.
  waitForTransaction(txHash: string): Promise<unknown>;
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
export async function resolveAccount(chatId: string, chain: Chain, config: Config): Promise<AccountResult> {
  // Sessions are namespaced by chain on disk:
  //   <dataDir>/sessions/<chain>/<chatId>/session.json
  const basePath = join(config.dataDir, "sessions", chain, chatId);
  // Use the same RPC the auth flow uses — Cartridge's own endpoint. The
  // budokan-sdk default for sepolia was Blast in v0.1.23, which starknet.js
  // can't always parse responses from ("code 131: data did not match any
  // variant of untagged enum JsonRpcResponse" at execute time). BUDOKAN_RPC_URL
  // override still wins.
  const rpcUrl = keychainSafeRpcUrl(chain, config.rpcUrl);

  const provider = new SessionProvider({
    rpc: rpcUrl,
    chainId: chainIdFor(chain),
    policies: buildSessionPolicies(chain, config.budokanAddress),
    basePath,
  });

  // probe() returns undefined for all of: no session file, time-expired, and
  // policy-mismatch (the persisted session was authorized for a narrower policy
  // bundle than we now require — e.g. after a new entry-fee token was added to
  // the spending-limit policies). Disambiguate so the user gets the right nudge.
  const sessionFile = join(basePath, "session.json");
  if (!existsSync(sessionFile)) {
    return { ok: false, reason: "no_session" };
  }

  const account = await provider.probe();
  if (!account) {
    // The file exists. If it's still valid in time, the failure is a policy
    // mismatch (re-/connect to widen consent); otherwise it's expired.
    let reason: "expired" | "policy_mismatch" = "expired";
    try {
      const parsed = JSON.parse(await readFile(sessionFile, "utf8")) as {
        session?: { expiresAt?: string };
      };
      const expiresAt = Number(parsed?.session?.expiresAt);
      if (Number.isFinite(expiresAt) && Date.now() < expiresAt * 1000) {
        reason = "policy_mismatch";
      }
    } catch {
      // Unreadable/corrupt file — treat as expired.
    }
    return { ok: false, reason };
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

export function chainIdFor(chain: Chain): constants.StarknetChainId {
  return chain === "mainnet"
    ? constants.StarknetChainId.SN_MAIN
    : constants.StarknetChainId.SN_SEPOLIA;
}
