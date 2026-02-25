export interface BudokanClientConfig {
  apiBaseUrl: string;
  wsUrl?: string;
  rpcUrl?: string;
  contractAddress?: string;
  retryAttempts?: number;
  retryDelay?: number;
  timeout?: number;
}
