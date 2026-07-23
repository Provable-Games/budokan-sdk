// One read client per chain, created lazily. The WebSocket layer is never
// connected — MCP tools are request/response, so plain REST/RPC reads are
// all we need.

import { CHAINS, createBudokanClient, type BudokanClient } from "@provable-games/budokan-sdk";
import { createDenshokanClient, type DenshokanClient } from "@provable-games/denshokan-sdk";
import type { Chain } from "./config.ts";

const budokan = new Map<Chain, BudokanClient>();
const denshokan = new Map<Chain, DenshokanClient>();

export function budokanClient(chain: Chain): BudokanClient {
  let c = budokan.get(chain);
  if (!c) {
    c = createBudokanClient({ chain, apiBaseUrl: CHAINS[chain]!.apiBaseUrl });
    budokan.set(chain, c);
  }
  return c;
}

export function denshokanClient(chain: Chain): DenshokanClient {
  let c = denshokan.get(chain);
  if (!c) {
    c = createDenshokanClient({ chain });
    denshokan.set(chain, c);
  }
  return c;
}
