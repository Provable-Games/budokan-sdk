import { useEffect, useRef, useState } from "react";
import type { WSChannel, WSEventMessage } from "../types/websocket.js";
import { useBudokanClient } from "./context.js";

export interface UseSubscriptionResult {
  lastMessage: WSEventMessage | null;
  isConnected: boolean;
}

/**
 * Hook to subscribe to WebSocket channels for real-time updates.
 * Automatically connects and subscribes on mount, and cleans up on unmount.
 */
export function useSubscription(
  channels: WSChannel[],
  tournamentIds?: string[],
): UseSubscriptionResult {
  const client = useBudokanClient();
  const [lastMessage, setLastMessage] = useState<WSEventMessage | null>(null);
  const [isConnected, setIsConnected] = useState(client.wsConnected);
  const channelsRef = useRef(channels);
  const tournamentIdsRef = useRef(tournamentIds);

  // Keep refs updated for stable comparisons
  channelsRef.current = channels;
  tournamentIdsRef.current = tournamentIds;

  useEffect(() => {
    if (channels.length === 0) return;

    client.connect();

    const unsubscribe = client.subscribe(
      channels,
      (message) => setLastMessage(message),
      tournamentIds,
    );

    const unsubscribeConnection = client.onWsConnectionChange((connected) => {
      setIsConnected(connected);
    });

    return () => {
      unsubscribe();
      unsubscribeConnection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, JSON.stringify(channels), JSON.stringify(tournamentIds)]);

  return { lastMessage, isConnected };
}
