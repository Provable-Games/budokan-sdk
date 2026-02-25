import { createContext, useContext, useMemo, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { BudokanClient, createBudokanClient } from "../client.js";
import type { BudokanClientConfig } from "../types/config.js";

const BudokanContext = createContext<BudokanClient | null>(null);

export interface BudokanProviderProps {
  children: ReactNode;
  config?: BudokanClientConfig;
  client?: BudokanClient;
}

/**
 * Provides a BudokanClient instance to all child components via React context.
 * Supply either a `config` prop to auto-create a client, or an existing `client` instance.
 */
export function BudokanProvider({ children, config, client: existingClient }: BudokanProviderProps) {
  const client = useMemo(() => {
    if (existingClient) return existingClient;
    if (config) return createBudokanClient(config);
    throw new Error("BudokanProvider requires either 'config' or 'client' prop");
  }, [existingClient, config]);

  const clientRef = useRef(client);

  useEffect(() => {
    // Cleanup previous client if it changed and was created internally
    return () => {
      if (!existingClient && clientRef.current !== client) {
        clientRef.current.disconnect();
      }
    };
  }, [client, existingClient]);

  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  return (
    <BudokanContext.Provider value={client}>
      {children}
    </BudokanContext.Provider>
  );
}

/**
 * Access the BudokanClient instance from context.
 * Must be used within a BudokanProvider.
 */
export function useBudokanClient(): BudokanClient {
  const client = useContext(BudokanContext);
  if (!client) {
    throw new Error("useBudokanClient must be used within a BudokanProvider");
  }
  return client;
}
