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
  return process.env.STARKNET_RPC_URL ?? chainConfig(chain).rpcUrl;
}

export function resolveChain(chain?: string): Chain {
  if (chain === "mainnet" || chain === "sepolia") return chain;
  return DEFAULT_CHAIN;
}
