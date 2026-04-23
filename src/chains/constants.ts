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
    budokanAddress: "0x0105573bf9184f0a3da78dda70a87055e6aafc7b3fb6e331732a0d25675b7be5",
    viewerAddress: "0x0414fe2f48db1e3598a83f017d17b4d06cec180b160141fea9244054267c1ff1",
  },
} as const;

export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAINS[chain];
}
