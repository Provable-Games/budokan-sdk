import type { ConnectionStatus } from "./health.js";
import { DataSourceError } from "../errors/index.js";

export async function withFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  health?: ConnectionStatus,
): Promise<T> {
  // If health monitoring shows primary source is down, skip it
  if (health) {
    const mode = health.mode;
    if (mode === "rpc-fallback") {
      // API is known-down, go straight to RPC fallback
      try {
        return await fallback();
      } catch (fallbackError) {
        throw fallbackError;
      }
    }

    if (mode === "offline") {
      // Both are known-down, still try both in order
    }
  }

  let primaryError: Error;
  try {
    return await primary();
  } catch (error) {
    primaryError = error as Error;
    // Report failure to health service
    if (health) {
      health.markApiUnavailable(primaryError.message);
    }
  }

  try {
    return await fallback();
  } catch (fallbackError) {
    if (health) {
      health.markRpcUnavailable((fallbackError as Error).message);
    }
    throw new DataSourceError(primaryError, fallbackError as Error);
  }
}
