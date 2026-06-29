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

// Session spend caps are sized to ~$10/token — enough for entry fees, which is
// all the session does in-bot. Larger prize funding is done on budokan.gg, not
// in-session. Stablecoins are exact $10; the volatile tokens (STRK/ETH/LORDS)
// are rough $10 approximations at current prices — tune as prices move.
const STRK: Erc20Token = {
  address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  symbol: "STRK",
  name: "Starknet Token",
  decimals: 18,
  spendLimit: "50000000000000000000", // ~50 STRK (≈$10)
};

const ETH: Erc20Token = {
  address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  spendLimit: "3000000000000000", // 0.003 ETH (≈$10)
};

const USDC: Erc20Token = {
  address: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  spendLimit: "10000000", // 10 USDC
};

const USDT: Erc20Token = {
  address: "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8",
  symbol: "USDT",
  name: "Tether",
  decimals: 6,
  spendLimit: "10000000", // 10 USDT
};

const LORDS: Erc20Token = {
  address: "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49",
  symbol: "LORDS",
  name: "Lords",
  decimals: 18,
  spendLimit: "150000000000000000000", // ~150 LORDS (≈$10)
};

const DAI: Erc20Token = {
  address: "0x05574eb6b8789a91466f902c380d978e472db68170ff82a5b650b95a58ddf4ad",
  symbol: "DAI",
  name: "Dai Stablecoin",
  decimals: 18,
  spendLimit: "10000000000000000000", // 10 DAI
};

const MAINNET_TOKENS: readonly Erc20Token[] = [STRK, ETH, USDC, LORDS, USDT, DAI];

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
