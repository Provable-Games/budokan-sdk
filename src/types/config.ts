export type DataSource = "api" | "rpc";

export interface BudokanClientConfig {
  apiBaseUrl: string;
  wsUrl?: string;
  rpcUrl?: string;
  chain?: "mainnet" | "sepolia";
  provider?: unknown;
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
