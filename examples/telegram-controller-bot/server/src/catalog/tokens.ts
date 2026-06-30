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

// Session spend caps are ~$10/token — enough for entry fees, which is all the
// session does in-bot (larger prize funding is deferred to budokan.gg). The cap
// must be STABLE: it's signed into the session at /connect, and the same value
// is re-derived to validate every later action — a live, per-call price would
// drift and trip a policy mismatch (forcing a needless re-connect/register).
// So these are STATIC $10-equivalents, sized from Ekubo quoter "$10 → token"
// quotes (prod-api-quoter.ekubo.org) with a little headroom; refresh them
// periodically as prices move rather than computing per request.
//
// Token metadata: standard tokens mirror Ekubo's MAINNET_TOKENS; SURVIVOR/CASH
// (not in Ekubo's list) come from the Provable Games registry
// (presets/src/generated/erc20-metadata.ts).
const STRK: Erc20Token = {
  address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  symbol: "STRK",
  name: "Starknet Token",
  decimals: 18,
  spendLimit: "350000000000000000000", // ~350 STRK (≈$10 @ Ekubo)
};

const ETH: Erc20Token = {
  address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
  spendLimit: "6700000000000000", // ~0.0067 ETH (≈$10 @ Ekubo)
};

const USDC: Erc20Token = {
  address: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  spendLimit: "10000000", // 10 USDC
};

const LORDS: Erc20Token = {
  address: "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49",
  symbol: "LORDS",
  name: "Lords",
  decimals: 18,
  spendLimit: "3300000000000000000000", // ~3300 LORDS (≈$10 @ Ekubo)
};

const SURVIVOR: Erc20Token = {
  address: "0x042dd777885ad2c116be96d4d634abc90a26a790ffb5871e037dd5ae7d2ec86b",
  symbol: "SURVIVOR",
  name: "Survivor",
  decimals: 18,
  spendLimit: "200000000000000000000", // ~200 SURVIVOR (≈$10 @ Ekubo)
};

const CASH: Erc20Token = {
  address: "0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55ada",
  symbol: "CASH",
  name: "Cash",
  decimals: 18,
  spendLimit: "11000000000000000000", // ~11 CASH (≈$10 @ Ekubo)
};

const MAINNET_TOKENS: readonly Erc20Token[] = [STRK, ETH, USDC, LORDS, SURVIVOR, CASH];

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
