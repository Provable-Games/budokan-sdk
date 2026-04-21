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
    budokanAddress: "0x0124745dd41f3ad57e451b05a2d4db9bedaad351ac7643e552171aa5b0816c7a",
    viewerAddress: "0x07eaa10078ef122cf55bbb39de8a999c7269946208e016627f41674b7cfe944f",
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
