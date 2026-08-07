export interface ChainConfig {
  rpcUrl: string;
  apiBaseUrl: string;
  wsUrl: string;
  budokanAddress: string;
  viewerAddress: string;
  /** On-chain bracket contract (packages/bracket) — escrow + VRF + gated tree. */
  bracketAddress: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  mainnet: {
    rpcUrl: "https://rpc.provable.games/rpc",
    apiBaseUrl: "https://budokan-api-production.up.railway.app",
    wsUrl: "wss://budokan-api-production.up.railway.app/ws",
    // Fresh-architecture deployment (post-#315, 2026-08-07): exact payouts,
    // Geometric/Tiered, protocol_fee_info + license views. Fee OFF at genesis.
    budokanAddress: "0x01f2c86ab22ded7f2de9084578ce72a1f7b590d5be6bd5f912ac8053128c20c2",
    viewerAddress: "0x01af740a39e88a0e617b84ffcd0dc7f0f2f34b2bf4bcb5be0dce3ed9858fadb7",
    bracketAddress: "0x03b7b2b43a449b27b7e19400baa8d1eea8f05a6ad9416dace77b781414e4d66f",
  },
  sepolia: {
    rpcUrl: "https://api.cartridge.gg/x/starknet/sepolia/rpc/v0_10",
    apiBaseUrl: "https://budokan-api-sepolia.up.railway.app",
    wsUrl: "wss://budokan-api-sepolia.up.railway.app/ws",
    // Mainnet-parity deployment (budokan #315, 2026-08-07): exact payouts,
    // Geometric/Tiered, protocol_fee_info + license views. This is the
    // contract budokan.gg + budokan-api-sepolia index.
    budokanAddress: "0x011067f85b3ad43e6d0555d2dd55f9b0013ff86d35ad5e40e9343989ed3ba000",
    viewerAddress: "0x042e7d012b0c6e1cee122beb79e8cefce674fc480939771391809034adde7ecd",
    bracketAddress: "0x0751bd2c742c4c09f02f4af0fb4da51c582b22058ca62784dfa074c3490fa7a8",
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
