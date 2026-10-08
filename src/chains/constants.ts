export interface ChainConfig {
  rpcUrl: string;
  apiBaseUrl: string;
  wsUrl: string;
  budokanAddress: string;
  viewerAddress: string;
  /** On-chain bracket contract (packages/bracket) — escrow + VRF + gated tree. */
  bracketAddress: string;
  /** The bracket contract's deploy block: where the chain fallback scans `BracketCreated`. */
  bracketStartBlock: number;
}

export const CHAINS: Record<string, ChainConfig> = {
  mainnet: {
    rpcUrl: "https://rpc.provable.games/rpc",
    apiBaseUrl: "https://budokan-api-production.up.railway.app",
    wsUrl: "wss://budokan-api-production.up.railway.app/ws",
    // Budokan v2 (lite-only tokens, budokan #313); deployed at block 14065996.
    // budokan-api-production indexes this contract after the v2 cutover
    // (budokan contracts/DEPLOY_MAINNET_RUNBOOK.md).
    budokanAddress: "0x019f145601d5dbc087e2eacd9e6b36b6ff7b1a206362ecf4b59e1de7a5aad5c7",
    viewerAddress: "0x019efd3c3b6fc02da64027a2c423837ff4518d92dd873f1ed7ae1112e9632a64",
    bracketAddress: "0x07c0c83498814f69b8f99ce959a389407b1a7f10630c627c365dc556c9c53ce7",
    bracketStartBlock: 15845175,
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
    bracketStartBlock: 11806766,
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
