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
    budokanAddress: "0x0072a26c29ba5021508bbbb8487663a2a536b8a926acf388d3d772961bd063e0",
    viewerAddress: "0x06bef644110a02c1b075b539953c707cd03b4bb32b42f5f1b0b0090b5139529f",
  },
} as const;

export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAINS[chain];
}
