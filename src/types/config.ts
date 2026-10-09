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
  /**
   * How long a bracket read's answer is reused, in ms (default 5000). Identical reads in flight
   * are always shared; 0 disables reuse after they settle.
   */
  bracketCacheMs?: number;
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
