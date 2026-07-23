// Environment-driven configuration.
//
// The server is chain-flexible: every tool takes an optional `chain`
// parameter, and BUDOKAN_CHAIN only sets the default. Signing material is
// resolved per chain in wallet.ts (env vars first, then the generated
// keystore file).

import { CHAINS, type ChainConfig } from "@provable-games/budokan-sdk";
import { homedir } from "node:os";
import { join } from "node:path";

export type Chain = "mainnet" | "sepolia";

export const DEFAULT_CHAIN: Chain =
  process.env.BUDOKAN_CHAIN === "sepolia" ? "sepolia" : "mainnet";

/** Directory holding generated dev-wallet keystores (0600 files). */
export const KEYSTORE_DIR =
  process.env.BUDOKAN_MCP_DIR ?? join(homedir(), ".budokan-mcp");

export function chainConfig(chain: Chain): ChainConfig {
  return CHAINS[chain]!;
}

export function rpcUrlFor(chain: Chain): string {
  // Chain-specific overrides only — a single override applied to every chain
  // would route (signed!) calls for the other chain to the wrong network. The
  // bare STARKNET_RPC_URL therefore only applies to the default chain.
  const perChain = process.env[`STARKNET_RPC_URL_${chain.toUpperCase()}`];
  if (perChain) return perChain;
  if (chain === DEFAULT_CHAIN && process.env.STARKNET_RPC_URL) {
    return process.env.STARKNET_RPC_URL;
  }
  return chainConfig(chain).rpcUrl;
}

export function resolveChain(chain?: string): Chain {
  if (chain === "mainnet" || chain === "sepolia") return chain;
  return DEFAULT_CHAIN;
}
