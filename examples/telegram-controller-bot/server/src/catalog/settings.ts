// Per-game settings list, fetched via @provable-games/denshokan-sdk's
// indexer API (DenshokanClient.getSettings). Used to render numbered
// settings pickers during /create.
//
// Caches one client per chain; settings are paginated server-side, so we
// just pass through limit/offset.

import { createDenshokanClient, type DenshokanClient, type GameSettingDetails } from "@provable-games/denshokan-sdk";

import type { Chain } from "../chat-state.ts";

const clients = new Map<Chain, DenshokanClient>();

function getClient(chain: Chain): DenshokanClient {
  let client = clients.get(chain);
  if (!client) {
    client = createDenshokanClient({ chain });
    clients.set(chain, client);
  }
  return client;
}

export interface SettingsPage {
  data: GameSettingDetails[];
  total: number;
  limit: number;
  offset: number;
}

export async function fetchSettings(
  chain: Chain,
  gameAddress: string,
  options: { limit?: number; offset?: number } = {},
): Promise<SettingsPage> {
  const limit = options.limit ?? 5;
  const offset = options.offset ?? 0;
  const result = await getClient(chain).getSettings({ gameAddress, limit, offset });
  return {
    data: result.data,
    total: result.total,
    limit,
    offset,
  };
}

export type { GameSettingDetails } from "@provable-games/denshokan-sdk";
