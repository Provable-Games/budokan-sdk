// Per-chain game catalog. Source of truth is denshokan-sdk's game registry
// (DenshokanClient.getGames) — that's the same registry settings live in,
// so games and their settings are always consistent. We layer some
// metadata on top (defaults from budokan/client/src/assets/games/index.tsx)
// when the registered address matches a known game, but lookups never
// fail just because there's no metadata.
//
// The bot uses this for:
//   - /create's first picker (numbered list of registered games)
//   - displaying friendly names elsewhere

import { createDenshokanClient, type DenshokanClient } from "@provable-games/denshokan-sdk";

import type { Chain } from "../chat-state.ts";

const STRK_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// Curated metadata keyed by lowercase contract address. Only fields that
// denshokan-sdk's Game doesn't carry. Lookup is a no-op miss when an
// address isn't here — we don't depend on it.
interface GameMetadata {
  defaultEntryFeeToken?: string;
  defaultGameFeePercentage?: number;
  controllerOnly?: boolean;
}

const METADATA: Record<string, GameMetadata> = {
  // mainnet Death Mountain
  "0x4de0351ceab4ecd50be6ee09329b0dcb3b96a9da88cc158f453823a389722fa": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
    defaultGameFeePercentage: 5,
  },
  // mainnet zKube
  "0x642f228f70b1ca7edb4ab7ff0bab067369c2e276ddc2570ca18802d4e758edc": {
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  // sepolia Dark Shuffle
  "0x04359aee29873cd9603207d29b4140468bac3e042aa10daab2e1a8b2dd60ef7b": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  // sepolia Death Mountain
  "0x07ae26eecf0274aabb31677753ff3a4e15beec7268fa1b104f73ce3c89202831": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  // sepolia Nums
  "0x012ccc9a2d76c836d088203f6e9d62e22d1a9f7479d1aea8b503a1036c0f4487": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  // sepolia Number Guess
  "0x3a2ea07f0f49c770035eed9a010eb3d1e1bc3cb92e1d47eef2ad75a25c6bdb2": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  // sepolia zKube
  "0x5e02a1f750b3fa0e835d454705b664ecb23166cdb49459b1c96c1e3eaf9a2f4": {
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
};

export interface Game {
  contractAddress: string;
  name: string;
  description?: string;
  imageUrl?: string;
  defaultEntryFeeToken?: string;
  defaultGameFeePercentage?: number;
  controllerOnly?: boolean;
}

const clients = new Map<Chain, DenshokanClient>();

function getClient(chain: Chain): DenshokanClient {
  let client = clients.get(chain);
  if (!client) {
    client = createDenshokanClient({ chain });
    clients.set(chain, client);
  }
  return client;
}

/**
 * List games registered with denshokan on the given chain. Returns an
 * empty array on indexer failure (caller should treat as "no games").
 *
 * Sorted by name for stable numbering across reloads.
 */
export async function gamesForChain(chain: Chain): Promise<Game[]> {
  let result;
  try {
    result = await getClient(chain).getGames({ limit: 100 });
  } catch {
    return [];
  }
  return result.data
    .map((g): Game => {
      const meta = METADATA[g.contractAddress.toLowerCase()] ?? {};
      return {
        contractAddress: g.contractAddress,
        name: g.name,
        description: g.description,
        imageUrl: g.imageUrl,
        ...meta,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Look up a game by contract address. Used by /enter and /tournament displays. */
export async function findGame(chain: Chain, contractAddress: string): Promise<Game | undefined> {
  const target = contractAddress.toLowerCase();
  const list = await gamesForChain(chain);
  return list.find((g) => g.contractAddress.toLowerCase() === target);
}
