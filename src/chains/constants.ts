export interface ChainConfig {
  rpcUrl: string;
  apiBaseUrl: string;
  wsUrl: string;
  budokanAddress: string;
  viewerAddress: string;
  /** On-chain bracket contract (packages/bracket): escrow, block-hash draw and gated tree. */
  bracketAddress: string;
  /** The bracket contract's deploy block: where the chain fallback scans `BracketCreated`. */
  bracketStartBlock: number;
}

export const CHAINS: Record<string, ChainConfig> = {
  mainnet: {
    rpcUrl: "https://rpc.provable.games/rpc",
    apiBaseUrl: "https://api-packed-production.up.railway.app",
    wsUrl: "wss://api-packed-production.up.railway.app/ws",
    // Fresh packed-state release (budokan #354/#355/#357), deploy block 16278878.
    // IDs restart at 1: use this address, viewer and fresh API together.
    // The previous deployment remains available through explicit client overrides.
    budokanAddress: "0x341263a7a0fda541d57b4de1365017066badee008d5536a8adbb14c9292be57",
    viewerAddress: "0x49f78887ca959bf1738ee5a875c5ad948b4e79bdcb39315f4f9ac93d7c78c8",
    bracketAddress: "0x525e28ecaf636e9dfb7b03221965614bc43afd173048f1dc9b96705fff846d",
    bracketStartBlock: 16278886,
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
