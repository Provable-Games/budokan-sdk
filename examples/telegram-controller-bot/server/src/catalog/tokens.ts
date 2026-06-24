// Curated per-chain token list for entry-fee picking. Subset of
// budokan/client/src/lib/{mainnet,sepolia}Tokens.ts — we only carry the
// most commonly-used tournament tokens because the chat picker is
// numbered, not searchable.
//
// For prize sponsorship (the "what's in your wallet" picker) we use
// Voyager balances at runtime (see voyager.ts), not this list.

import { normalizeAddress } from "@provable-games/budokan-sdk";

import type { Chain } from "../chat-state.ts";

export interface Erc20Token {
  address: string;     // lowercase hex
  symbol: string;
  name: string;
  decimals: number;
  /**
   * Per-token session spending cap, in base units (decimal string). Authorized
   * once at /connect as a Cartridge spending limit so paid /enter can run
   * in-session without a per-tx popup. The keychain shows the user this cap and
   * enforces it cumulatively across the session; the bot only ever approves the
   * exact entry fee, so a normal user stays well under it. Tune to taste.
   * Optional: tokens without it (ad-hoc prize tokens) aren't eligible for
   * in-session paid entry.
   */
  spendLimit?: string;
};

const STRK: Erc20Token = {
  address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  symbol: "STRK",
  name: "Starknet Token",
  decimals: 18,
  spendLimit: "10000000000000000000000", // 10,000 STRK
};

const ETH: Erc20Token = {
  address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  spendLimit: "1000000000000000000", // 1 ETH
};

const USDC: Erc20Token = {
  address: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  spendLimit: "5000000000", // 5,000 USDC
};

const USDT: Erc20Token = {
  address: "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8",
  symbol: "USDT",
  name: "Tether",
  decimals: 6,
  spendLimit: "5000000000", // 5,000 USDT
};

const LORDS: Erc20Token = {
  address: "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49",
  symbol: "LORDS",
  name: "Lords",
  decimals: 18,
  spendLimit: "50000000000000000000000", // 50,000 LORDS
};

const DAI: Erc20Token = {
  address: "0x05574eb6b8789a91466f902c380d978e472db68170ff82a5b650b95a58ddf4ad",
  symbol: "DAI",
  name: "Dai Stablecoin",
  decimals: 18,
  spendLimit: "5000000000000000000000", // 5,000 DAI
};

// Provable / Death Mountain game tokens (mainnet). Addresses sourced from
// death-mountain-client's networkConfig.ts / greed.ts / opusYieldConfig.ts.
// All 18-decimal (greed cost_to_play = 10 SURVIVOR = 10e18; one dungeon ticket
// = 1e18). Caps are generous starting points — tune to taste.
const SURVIVOR: Erc20Token = {
  address: "0x042dd777885ad2c116be96d4d634abc90a26a790ffb5871e037dd5ae7d2ec86b",
  symbol: "SURVIVOR",
  name: "Survivor",
  decimals: 18,
  spendLimit: "10000000000000000000000", // 10,000 SURVIVOR
};

const CASH: Erc20Token = {
  address: "0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55ada",
  symbol: "CASH",
  name: "Cash",
  decimals: 18,
  spendLimit: "5000000000000000000000", // 5,000 CASH
};

const DTICKET: Erc20Token = {
  address: "0x0452810188c4cb3aebd63711a3b445755bc0d6c4f27b923fdd99b1a118858136",
  symbol: "DTICKET",
  name: "Dungeon Ticket",
  decimals: 18,
  spendLimit: "1000000000000000000000", // 1,000 tickets
};

const MAINNET_TOKENS: readonly Erc20Token[] = [
  STRK,
  ETH,
  USDC,
  LORDS,
  USDT,
  DAI,
  SURVIVOR,
  CASH,
  DTICKET,
];

// Sepolia uses the same canonical addresses for the headline tokens — most
// dapps don't issue separate sepolia ERC-20s.
const SEPOLIA_TOKENS: readonly Erc20Token[] = [STRK, ETH];

export function tokensForChain(chain: Chain): readonly Erc20Token[] {
  return chain === "mainnet" ? MAINNET_TOKENS : SEPOLIA_TOKENS;
}

export function findKnownToken(chain: Chain, address: string): Erc20Token | undefined {
  // Normalize both sides — the indexer drops leading zeros from
  // ContractAddress fields (e.g. STRK comes back as 0x4718…7c938d, not
  // 0x04718…7c938d) so a plain lowercase compare misses our canonical
  // table entries. normalizeAddress strips leading zeros then pads to 64
  // hex chars, giving a stable key.
  const target = normalizeAddress(address);
  return tokensForChain(chain).find(
    (t) => normalizeAddress(t.address) === target,
  );
}
