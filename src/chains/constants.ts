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
    budokanAddress: "0x06137ee50f57d08e1d0d758045e45982e2f5ef4826091ed4db136e7afbafecce",
    viewerAddress: "0x075d1b9f1a9751e6b8f8b5a4ca8e721f10c58d87607e703cda062e512a434443",
  },
  sepolia: {
    rpcUrl: "https://starknet-sepolia.public.blastapi.io",
    apiBaseUrl: "https://budokan-api-sepolia.up.railway.app",
    wsUrl: "wss://budokan-api-sepolia.up.railway.app/ws",
    budokanAddress: "0x0423583f0e9461708a3eb763f1c4d89dbda03814da0f048af5eefd9c97e742ef",
    viewerAddress: "0x0568f6078cdf5d9aad881c3a9da1be58fc83018a198bb78ca43a663070a4fcbb",
  },
} as const;

export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAINS[chain];
}
