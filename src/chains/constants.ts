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
    budokanAddress: "0x0596ced030e74ebc37f33607f07ecd5a62eff22cdc4ae31fe2d724040c1bdc0b",
    viewerAddress: "0x013c8239361fdbd7ec26db2c83f4ff270c5bba83a0bc105b4005b676ff57fdbe",
  },
  sepolia: {
    rpcUrl: "https://starknet-sepolia.public.blastapi.io",
    apiBaseUrl: "https://budokan-api-sepolia.up.railway.app",
    wsUrl: "wss://budokan-api-sepolia.up.railway.app/ws",
    budokanAddress: "0x017750a167b7c4968249d7db06dccc8b3908ef8954cb40cfe4d3c651ca0dcd1d",
    viewerAddress: "0x03d5febe0042b943967074f4ebd850a6b5d50850cd3fb84fbd0eb66dadd9ddec",
  },
} as const;

export function getChainConfig(chain: string): ChainConfig | undefined {
  return CHAINS[chain];
}
