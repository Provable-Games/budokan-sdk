export interface ChainConfig {
  rpcUrl: string;
  apiBaseUrl: string;
  wsUrl: string;
  budokanAddress: string;
  viewerAddress: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  mainnet: {
    rpcUrl: "https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_10",
    apiBaseUrl: "https://budokan-api-production.up.railway.app",
    wsUrl: "wss://budokan-api-production.up.railway.app/ws",
    budokanAddress: "0x0596ced030e74ebc37f33607f07ecd5a62eff22cdc4ae31fe2d724040c1bdc0b",
    viewerAddress: "0x013c8239361fdbd7ec26db2c83f4ff270c5bba83a0bc105b4005b676ff57fdbe",
  },
  sepolia: {
    rpcUrl: "https://api.cartridge.gg/x/starknet/sepolia/rpc/v0_10",
    apiBaseUrl: "https://budokan-api-sepolia.up.railway.app",
    wsUrl: "wss://budokan-api-sepolia.up.railway.app/ws",
    budokanAddress: "0x074cc823c382d98e6b8d657aa86776a57d85e1dc2912d54d83a4fef147472683",
    // Redeployed 2026-06-18 to match the upgraded #264/#269 budokan class —
    // the prior viewer (0x03da56…) was built against the old budokan interface
    // (called the removed `tournament_entries`) and reverted RPC reads.
    viewerAddress: "0x06b2773d5f1f8bfa5aa3b698fbbaea0472b30af003ea6058330ed52a1acaa283",
  },
} as const;

export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAINS[chain];
}

/**
 * Voyager block-explorer base URL for the chain. Used to build
 * shareable links for tx hashes and contracts in chat / Discord / CLI
 * surfaces. Unknown chains fall back to mainnet — Voyager 404s
 * gracefully and the caller can still click the link.
 */
export function explorerBaseUrl(chain: string): string {
  if (chain === "sepolia") return "https://sepolia.voyager.online";
  return "https://voyager.online";
}

/** Voyager URL for a transaction hash. */
export function explorerTxUrl(chain: string, txHash: string): string {
  return `${explorerBaseUrl(chain)}/tx/${txHash}`;
}

/** Voyager URL for a contract / account address. */
export function explorerAddressUrl(chain: string, address: string): string {
  return `${explorerBaseUrl(chain)}/contract/${address}`;
}

/**
 * Canonical budokan.gg URL for a tournament. The `network` query param
 * tells the client which chain to load — important when sharing sepolia
 * tournaments since the site defaults to mainnet.
 */
export function tournamentPageUrl(
  chain: string,
  // u64 on-chain — accept bigint/string losslessly (parseTournamentIdFromReceipt
  // returns bigint). number is allowed for convenience.
  tournamentId: string | number | bigint,
): string {
  return `https://budokan.gg/tournament/${tournamentId}?network=${chain}`;
}
