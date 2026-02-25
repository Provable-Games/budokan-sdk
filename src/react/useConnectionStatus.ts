import { useState, useEffect } from "react";
import { useBudokanClient } from "./context.js";
import type { ConnectionMode } from "../datasource/health.js";

/**
 * Hook returning the current WebSocket connection status and datasource mode.
 *
 * `datasourceMode` indicates how data is being fetched:
 * - `"api"` — API is available and being used
 * - `"rpc-fallback"` — API is down, using direct on-chain RPC calls
 * - `"offline"` — both API and RPC are unavailable
 */
export function useConnectionStatus(): {
  isConnected: boolean;
  datasourceMode: ConnectionMode;
} {
  const client = useBudokanClient();
  const [isConnected, setIsConnected] = useState(client.wsConnected);
  const [datasourceMode, setDatasourceMode] = useState<ConnectionMode>("api");

  useEffect(() => {
    const unsubWs = client.onWsConnectionChange((connected) => {
      setIsConnected(connected);
    });
    const unsubDs = client.onConnectionStatusChange((status) => {
      setDatasourceMode(status.mode);
    });
    return () => {
      unsubWs();
      unsubDs();
    };
  }, [client]);

  return { isConnected, datasourceMode };
}
