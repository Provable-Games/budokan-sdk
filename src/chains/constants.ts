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
    budokanAddress: "0x020239968a74f3e190d1b5aa0c6316845062a00cb98f787d661fd4aa860553de",
    viewerAddress: "0x00ace1cce7933fbf0d7a2f32c3b5d4c36e63462f81c7845b6d7ac5d8dbdbefa4",
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
