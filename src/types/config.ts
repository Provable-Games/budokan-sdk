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
  /** Bracket contract for the bracket chain fallback; defaults to the chain preset's. */
  bracketAddress?: string;
  /** Its deploy block, where the fallback starts scanning `BracketCreated` (default 0). */
  bracketStartBlock?: number;
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
