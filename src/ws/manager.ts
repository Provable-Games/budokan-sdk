import type { WSSubscribeOptions, WSEventHandler, WSEventMessage } from "../types/websocket.js";

interface WSManagerConfig {
  maxReconnectAttempts: number;
  reconnectBaseDelay: number;
}

const DEFAULT_WS_CONFIG: WSManagerConfig = {
  maxReconnectAttempts: 10,
  reconnectBaseDelay: 1000,
};

/**
 * WebSocket manager with auto-reconnect and subscription management.
 */
export class WSManager {
  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private readonly config: WSManagerConfig;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<string, { options: WSSubscribeOptions; handler: WSEventHandler }>();
  private nextSubId = 1;
  private connected = false;
  private connectionListeners = new Set<(connected: boolean) => void>();

  constructor(wsUrl: string, config?: Partial<WSManagerConfig>) {
    this.wsUrl = wsUrl;
    this.config = { ...DEFAULT_WS_CONFIG, ...config };
  }

  /**
   * Open a WebSocket connection. No-op if already connected.
   */
  connect(): void {
    if (this.ws) return;

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.notifyConnectionChange(true);
        // Re-subscribe all active subscriptions
        for (const [, sub] of this.subscriptions) {
          this.sendSubscribe(sub.options);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as WSEventMessage;
          if (message.type === "event") {
            for (const [, sub] of this.subscriptions) {
              sub.handler(message);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.notifyConnectionChange(false);
        this.ws = null;
        this.attemptReconnect();
      };

      this.ws.onerror = () => {
        // onclose will fire after onerror
      };
    } catch {
      this.attemptReconnect();
    }
  }

  /**
   * Close the WebSocket connection and stop reconnecting.
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.notifyConnectionChange(false);
    this.reconnectAttempts = 0;
  }

  /**
   * Subscribe to channels with an optional tournament filter.
   * Returns an unsubscribe function.
   */
  subscribe(options: WSSubscribeOptions, handler: WSEventHandler): () => void {
    const id = String(this.nextSubId++);
    this.subscriptions.set(id, { options, handler });

    if (this.connected) {
      this.sendSubscribe(options);
    }

    return () => {
      this.subscriptions.delete(id);
      if (this.connected && this.ws) {
        this.ws.send(JSON.stringify({
          type: "unsubscribe",
          channels: options.channels,
        }));
      }
    };
  }

  /**
   * Register a callback for a single message. Convenience wrapper around subscribe.
   * Returns an unsubscribe function.
   */
  onMessage(callback: WSEventHandler): () => void {
    const id = String(this.nextSubId++);
    // Subscribe to all channels by using a passthrough handler
    this.subscriptions.set(id, {
      options: { channels: [] },
      handler: callback,
    });

    return () => {
      this.subscriptions.delete(id);
    };
  }

  /**
   * Whether the WebSocket is currently connected.
   */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Register a listener for connection state changes.
   * Returns an unsubscribe function.
   */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  private notifyConnectionChange(isConnected: boolean): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(isConnected);
      } catch {
        // Ignore listener errors
      }
    }
  }

  private sendSubscribe(options: WSSubscribeOptions): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (options.channels.length === 0) return;
    this.ws.send(JSON.stringify({
      type: "subscribe",
      channels: options.channels,
      tournamentIds: options.tournamentIds,
    }));
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) return;
    if (this.subscriptions.size === 0) return;

    const delay = this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, Math.min(delay, 30_000));
  }
}
