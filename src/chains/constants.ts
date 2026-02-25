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
    apiBaseUrl: "https://budokan-api.provable.games",
    wsUrl: "wss://budokan-api.provable.games/ws",
    budokanAddress: "", // TODO: set after mainnet deployment
    viewerAddress: "", // TODO: set after mainnet deployment
  },
  sepolia: {
    rpcUrl: "https://starknet-sepolia.public.blastapi.io",
    apiBaseUrl: "https://budokan-api-sepolia.provable.games",
    wsUrl: "wss://budokan-api-sepolia.provable.games/ws",
    budokanAddress: "", // TODO: set after sepolia deployment
    viewerAddress: "", // TODO: set after sepolia deployment
  },
} as const;

export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAINS[chain];
}
