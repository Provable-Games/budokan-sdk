/**
 * Known-token catalog + amount formatting.
 *
 * Every builder in this SDK takes raw base-unit amounts (u128/u256 decimal
 * strings) because that's what the chain takes — but integrators think in
 * "5 STRK" / "0.25 USDC". This module owns that translation so bots, MCP
 * servers, and clients stop re-implementing it:
 *
 *   const strk = findKnownToken("mainnet", "STRK")!;
 *   const raw = toRawAmount("5", strk.decimals);   // "5000000000000000000"
 *
 * The catalog mirrors the curated per-chain token lists the budokan client
 * uses for entry fees. Pure/offline by design — tokens outside the catalog
 * need their `decimals` fetched by the caller (any RPC) and passed to
 * `toRawAmount` directly.
 */

import { normalizeAddress } from "../utils/address.js";
import type { WhitelistChain } from "../games/whitelist.js";

export interface KnownToken {
  /** Canonical 0x-prefixed, 66-char lowercase contract address. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

const STRK: KnownToken = {
  address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  symbol: "STRK",
  name: "Starknet Token",
  decimals: 18,
};
const ETH: KnownToken = {
  address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
};
const USDC: KnownToken = {
  address: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
};
const LORDS: KnownToken = {
  address: "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49",
  symbol: "LORDS",
  name: "Lords",
  decimals: 18,
};
const SURVIVOR: KnownToken = {
  address: "0x042dd777885ad2c116be96d4d634abc90a26a790ffb5871e037dd5ae7d2ec86b",
  symbol: "SURVIVOR",
  name: "Survivor",
  decimals: 18,
};
const CASH: KnownToken = {
  address: "0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55ada",
  symbol: "CASH",
  name: "Cash",
  decimals: 18,
};

// Sepolia reuses the canonical STRK/ETH addresses; the other tokens have no
// meaningful sepolia deployments.
const TOKENS: Record<WhitelistChain, readonly KnownToken[]> = {
  mainnet: [STRK, ETH, USDC, LORDS, SURVIVOR, CASH],
  sepolia: [STRK, ETH],
};

/** The curated fee/prize tokens for a chain. */
export function knownTokensForChain(chain: WhitelistChain): readonly KnownToken[] {
  return TOKENS[chain];
}

/**
 * Resolve a token reference — a symbol ("STRK", case-insensitive) or an
 * address in any representation — against the catalog. Returns undefined for
 * tokens outside it (fetch their `decimals` yourself and use `toRawAmount`).
 */
export function findKnownToken(chain: WhitelistChain, ref: string): KnownToken | undefined {
  if (ref.startsWith("0x")) {
    const target = normalizeAddress(ref);
    return TOKENS[chain].find((t) => normalizeAddress(t.address) === target);
  }
  const symbol = ref.toLowerCase();
  return TOKENS[chain].find((t) => t.symbol.toLowerCase() === symbol);
}

/**
 * Human decimal amount → raw base-unit string. `"1.5"` at 18 decimals →
 * `"1500000000000000000"`. Exact: throws on more fractional digits than the
 * token carries rather than silently rounding.
 */
export function toRawAmount(human: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`Invalid decimals ${decimals}`);
  }
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount "${human}" — use a plain decimal number like "5" or "0.25"`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`Amount "${human}" has more than ${decimals} decimal places`);
  }
  return (BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}

/** Raw base-unit amount → human decimal string (trailing zeros trimmed). */
export function fromRawAmount(raw: bigint | string, decimals: number): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  if (value < 0n) throw new Error("Amount must be non-negative");
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
