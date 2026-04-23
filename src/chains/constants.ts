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
    budokanAddress: "0x0765e6f07c1a5cebe08aba7f840741242dffb1ed77ac619120501f540ec9a52a",
    viewerAddress: "0x0232fb32bd06e38f3555000f255c01812198418d5fced3b6246900725bf2f4d1",
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
