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
    budokanAddress: "0x06970648aca3eedbd4e276c58f3edb65c9bc9c9901d1138699dfff4d5dd6b31f",
    viewerAddress: "0x00304e8f0424985ec0c2e92a8c46f2604ae072f2fc3a9056396837ae21cceed7",
  },
} as const;

export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAINS[chain];
}
