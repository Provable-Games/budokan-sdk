import type { RpcProvider } from "starknet";

export type DataSource = "api" | "rpc";

export interface BudokanClientConfig {
  apiBaseUrl: string;
  wsUrl?: string;
  rpcUrl?: string;
  /** Custom headers to send with every RPC request (e.g. Authorization). */
  rpcHeaders?: Record<string, string>;
  chain?: "mainnet" | "sepolia";
  provider?: RpcProvider;
  viewerAddress?: string;
  budokanAddress?: string;
  primarySource?: DataSource;
  retryAttempts?: number;
  retryDelay?: number;
  timeout?: number;
  health?: {
    initialCheckDelay?: number;
    checkInterval?: number;
    checkTimeout?: number;
  };
}
