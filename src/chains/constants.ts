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
    budokanAddress: "0x00f4941e73cc38f67f79ae1f7cdae48f28ca5a6c0e013f6136818e777f61c6ee",
    viewerAddress: "0x027c264f4417dfd25d0626bce7304e9b3140ab06afeaf639b2678d2a05f1beb3",
  },
  sepolia: {
    rpcUrl: "https://starknet-sepolia.public.blastapi.io",
    apiBaseUrl: "https://budokan-api-sepolia.up.railway.app",
    wsUrl: "wss://budokan-api-sepolia.up.railway.app/ws",
    budokanAddress: "0x0169083e63f3caff2c15f83eb238b1f4ab8f74903c0e6b5d433b448972c578d4",
    viewerAddress: "0x02cc4473948170cf42c2f3abc6391fd4401650375ee8e4661b7b6966cda4f15e",
  },
} as const;

export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAINS[chain];
}
