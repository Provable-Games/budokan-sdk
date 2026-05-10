// Hardcoded per-chain list of supported games. Ported from
// budokan/client/src/assets/games/index.tsx — keep in sync if the client's
// list changes. Used to render numbered chat pickers for /create and /enter
// instead of forcing the user to type a 64-character contract address.
//
// Logos are referenced as remote URLs so we don't bundle binary assets in
// the bot — the chat doesn't render the image anyway, but downstream Mini
// App work might want them.

import type { Chain } from "../chat-state.ts";

const STRK_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

export interface Game {
  contractAddress: string;
  name: string;
  url?: string;
  playUrl?: string;
  defaultEntryFeeToken?: string;
  defaultGameFeePercentage?: number;  // basis-points-style — 5 = 5%
  /** True if the game requires a Cartridge controller account to play. */
  controllerOnly?: boolean;
  disabled?: boolean;
}

const MAINNET_GAMES: readonly Game[] = [
  {
    contractAddress: "0x4de0351ceab4ecd50be6ee09329b0dcb3b96a9da88cc158f453823a389722fa",
    name: "Death Mountain",
    url: "https://deathmountain.gg/",
    playUrl: "https://deathmountain.gg/play?id=",
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
    defaultGameFeePercentage: 5,
  },
  {
    contractAddress: "0x642f228f70b1ca7edb4ab7ff0bab067369c2e276ddc2570ca18802d4e758edc",
    name: "zKube",
    url: "https://zkube.io",
    playUrl: "https://zkube.io/play/",
    defaultEntryFeeToken: STRK_ADDRESS,
  },
] as const;

const SEPOLIA_GAMES: readonly Game[] = [
  {
    contractAddress: "0x04359aee29873cd9603207d29b4140468bac3e042aa10daab2e1a8b2dd60ef7b",
    name: "Dark Shuffle",
    url: "https://darkshuffle.dev",
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  {
    contractAddress: "0x07ae26eecf0274aabb31677753ff3a4e15beec7268fa1b104f73ce3c89202831",
    name: "Death Mountain",
    url: "https://lootsurvivor.io/",
    playUrl: "https://lootsurvivor.io/survivor/play?id=",
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  {
    contractAddress: "0x012ccc9a2d76c836d088203f6e9d62e22d1a9f7479d1aea8b503a1036c0f4487",
    name: "Nums",
    url: "https://nums-blond.vercel.app/",
    playUrl: "https://nums-blond.vercel.app/",
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  {
    contractAddress: "0x3a2ea07f0f49c770035eed9a010eb3d1e1bc3cb92e1d47eef2ad75a25c6bdb2",
    name: "Number Guess",
    url: "https://funfactory.gg/games/1",
    playUrl: "https://funfactory.gg/tokens/{tokenId}/play",
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
  {
    contractAddress: "0x5e02a1f750b3fa0e835d454705b664ecb23166cdb49459b1c96c1e3eaf9a2f4",
    name: "zKube",
    url: "https://zkube-budokan-sepolia.vercel.app",
    playUrl: "https://zkube-budokan-sepolia.vercel.app/play/",
    controllerOnly: true,
    defaultEntryFeeToken: STRK_ADDRESS,
  },
] as const;

export function gamesForChain(chain: Chain): readonly Game[] {
  const list = chain === "mainnet" ? MAINNET_GAMES : SEPOLIA_GAMES;
  // Non-disabled first, alphabetical within each bucket so the numbering is stable across reloads.
  return [...list]
    .sort((a, b) => {
      const aDisabled = a.disabled ?? false;
      const bDisabled = b.disabled ?? false;
      if (aDisabled !== bDisabled) return aDisabled ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
}

export function findGame(chain: Chain, contractAddress: string): Game | undefined {
  const target = contractAddress.toLowerCase();
  return gamesForChain(chain).find((g) => g.contractAddress.toLowerCase() === target);
}
