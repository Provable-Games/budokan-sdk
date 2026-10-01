// One read client per chain, created lazily. The WebSocket layer is never
// connected — MCP tools are request/response, so plain REST/RPC reads are
// all we need.

import { createBudokanClient, type BudokanClient } from "@provable-games/budokan-sdk";
import { createDenshokanClient, type DenshokanClient } from "@provable-games/denshokan-sdk";
import { chainConfig, rpcUrlFor, type Chain } from "./config.ts";

const budokan = new Map<Chain, BudokanClient>();
const denshokan = new Map<Chain, DenshokanClient>();

export function budokanClient(chain: Chain): BudokanClient {
  let c = budokan.get(chain);
  if (!c) {
    const config = chainConfig(chain);
    c = createBudokanClient({ chain, apiBaseUrl: config.apiBaseUrl,
      budokanAddress: config.budokanAddress, viewerAddress: config.viewerAddress,
      // Until configured, use the legacy API without decoding legacy RPC data
      // through the new ABI. Preserve the wallet's per-chain RPC selection.
      rpcUrl: config.viewerAddress ? rpcUrlFor(chain) : "",
    });
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
