// Slot-pattern auth helpers. We mint a fresh session keypair locally, build
// the Cartridge keychain auth URL (https://x.cartridge.gg/session?...), and
// later receive the result via a redirect to /api/connect/<token>/callback.
//
// Mirrors the Rust pattern in cartridge-gg/slot's CLI login flow:
//   slot/cli/src/command/auth/login.rs
//   slot/slot/src/api.rs
// The slot CLI uses /slot + OAuth2 codes; we use /session + redirect_query_name=startapp
// because we want a session signing key (not just an API access token).

import { ec, encode, stark } from "starknet";
import { signerToGuid } from "@cartridge/controller-wasm";

import type { Config } from "./config.ts";
import type { Chain } from "./chat-state.ts";
import { CHAINS } from "@provable-games/budokan-sdk";
import { parsedPoliciesFor } from "./policies.ts";

const KEYCHAIN_URL = "https://x.cartridge.gg";

export interface SessionKeypair {
  privKey: string;          // 0x-prefixed hex felt
  pubKey: string;           // 0x-prefixed hex felt
  sessionKeyGuid: string;   // computed via Cartridge controller-wasm
}

export function generateSessionKeypair(): SessionKeypair {
  const privKey = stark.randomAddress();
  const pubKey = ec.starkCurve.getStarkKey(privKey);
  const sessionKeyGuid = signerToGuid({
    starknet: { privateKey: encode.addHexPrefix(privKey) },
  });
  return { privKey, pubKey, sessionKeyGuid };
}

export function buildAuthUrl(args: {
  config: Config;
  chain: Chain;
  pubKey: string;
  callbackUrl: string;
}): string {
  const { config, chain, pubKey, callbackUrl } = args;
  const rpcUrl = config.rpcUrl ?? CHAINS[chain]?.rpcUrl;
  if (!rpcUrl) {
    throw new Error(`No RPC URL for chain '${chain}'`);
  }
  const policies = parsedPoliciesFor(chain, config.budokanAddress);

  // Match the URL shape produced by SessionProvider's connect() in
  // controller/packages/controller/src/session/provider.ts. Cartridge expects
  // raw query values for some fields, but URL-encoding is safer for the
  // ones that contain special characters (URLs, JSON).
  const params: Array<[string, string]> = [
    ["public_key", pubKey],
    ["redirect_uri", callbackUrl],
    ["redirect_query_name", "startapp"],
    ["rpc_url", rpcUrl],
    ["policies", JSON.stringify(policies)],
  ];

  const query = params
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${KEYCHAIN_URL}/session?${query}`;
}

/** Decode the base64-JSON `startapp` payload Cartridge sends back. */
export interface SessionRegistration {
  username: string;
  address: string;
  ownerGuid: string;
  expiresAt: string;
  transactionHash?: string;
  guardianKeyGuid?: string;
  metadataHash?: string;
  sessionKeyGuid?: string;
}

export function decodeStartapp(encoded: string): SessionRegistration | null {
  try {
    // Cartridge's encoder may produce unpadded base64 (per session/provider.ts:padBase64).
    const padded = padBase64(encoded);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Partial<SessionRegistration>;
    if (
      typeof parsed.username !== "string" ||
      typeof parsed.address !== "string" ||
      typeof parsed.ownerGuid !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }
    return {
      username: parsed.username,
      address: parsed.address.toLowerCase(),
      ownerGuid: parsed.ownerGuid.toLowerCase(),
      expiresAt: parsed.expiresAt,
      transactionHash: parsed.transactionHash,
      guardianKeyGuid: parsed.guardianKeyGuid,
      metadataHash: parsed.metadataHash,
      sessionKeyGuid: parsed.sessionKeyGuid,
    };
  } catch {
    return null;
  }
}

function padBase64(value: string): string {
  const remainder = value.length % 4;
  if (remainder === 0) return value;
  return value + "=".repeat(4 - remainder);
}
