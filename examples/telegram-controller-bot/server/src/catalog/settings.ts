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

/** Fetch one settings entry's full details (incl. the game default, id 0).
 *  Returns null if it isn't indexed (e.g. a game with no registered settings —
 *  id 0 is then the contract's built-in default with nothing to show). */
export async function fetchSetting(
  chain: Chain,
  gameAddress: string,
  id: number,
): Promise<GameSettingDetails | null> {
  try {
    return await getClient(chain).getSetting(id, gameAddress);
  } catch {
    return null;
  }
}

/** Human-readable dump of a settings entry: name, description, and the actual
 *  config parameters — so an organizer can see what a setting (incl. "default")
 *  really does, instead of an opaque id. */
export function formatSettingsDetails(s: GameSettingDetails): string {
  const lines = [`⚙️ ${s.name || `Settings #${s.id}`}`];
  if (s.description) lines.push(s.description);
  const params = Object.entries(s.settings ?? {});
  if (params.length > 0) {
    lines.push("", "Parameters:", ...params.map(([k, v]) => `  • ${k}: ${v}`));
  } else {
    lines.push("", "(no parameters recorded — this is the game's built-in default)");
  }
  return lines.join("\n");
}

export type { GameSettingDetails } from "@provable-games/denshokan-sdk";
