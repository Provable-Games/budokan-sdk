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
    budokanAddress: "0x04dae41808911e51af8efe8ac3202cb3b2a32c10c169703010b7e0cbd885bf83",
    viewerAddress: "0x02ef405cf2a8e8aec2946e5be39fa4e8bcb51cea5ce3573760418e7cdc7e5a22",
  },
  sepolia: {
    rpcUrl: "https://starknet-sepolia.public.blastapi.io",
    apiBaseUrl: "https://budokan-api-sepolia.up.railway.app",
    wsUrl: "wss://budokan-api-sepolia.up.railway.app/ws",
    budokanAddress: "0x02a97de0b33fb115f5c32a58232d9941c4a5b2598aa71d30c094076cc592f94d",
    viewerAddress: "0x001f2be7ed811bfa859f8f6cf72d2458f36103ac172ff8e65a630bbcc6cf98c9",
  },
} as const;

export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAINS[chain];
}
