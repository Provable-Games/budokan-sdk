export interface ChainConfig {
  rpcUrl: string;
  apiBaseUrl: string;
  wsUrl: string;
  budokanAddress: string;
  viewerAddress: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  mainnet: {
    rpcUrl: "https://rpc.provable.games/rpc",
    apiBaseUrl: "https://budokan-api-production.up.railway.app",
    wsUrl: "wss://budokan-api-production.up.railway.app/ws",
    budokanAddress: "0x012eb6054aa269c3e60013693f650650d81952de60072f446406d2a89f0b518e",
    viewerAddress: "0x0486819bbeca6b5f4a6a4700495beee1de0694a145678da412f64967ae8ed281",
  },
  sepolia: {
    rpcUrl: "https://api.cartridge.gg/x/starknet/sepolia/rpc/v0_10",
    apiBaseUrl: "https://budokan-api-sepolia.up.railway.app",
    wsUrl: "wss://budokan-api-sepolia.up.railway.app/ws",
    // The contract budokan.gg + budokan-api-sepolia actually index. The prior
    // value (0x074cc8…) was a different deployment the indexer doesn't watch, so
    // tournaments created there never showed up in the app/API.
    budokanAddress: "0x07edaa23494bf6832b306310e2e933c1907674bf680ea84bc87fcbfb6e5c3aa4",
    viewerAddress: "0x0794dc020f79afce437ffea14ead0d7b83ecb4ea758e92cb99e0a0dffccaedde",
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
