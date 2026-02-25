import { useState, useEffect } from "react";
import { useBudokanClient } from "./context.js";

/**
 * Simple hook returning the current WebSocket connection status.
 */
export function useConnectionStatus(): { isConnected: boolean } {
  const client = useBudokanClient();
  const [isConnected, setIsConnected] = useState(client.wsConnected);

  useEffect(() => {
    const unsubscribe = client.onWsConnectionChange((connected) => {
      setIsConnected(connected);
    });
    return unsubscribe;
  }, [client]);

  return { isConnected };
}
