// Curated token list so tools can accept human amounts ("5 STRK") by
// symbol. Mirrors the controller bot's catalog (which mirrors the budokan
// client). Unknown tokens still work by address — decimals are read from
// the contract at call time.

import { normalizeAddress } from "@provable-games/budokan-sdk";
import { providerFor } from "./wallet.ts";
import type { Chain } from "./config.ts";

export interface Erc20Token {
  address: string;
  symbol: string;
  decimals: number;
}

const STRK: Erc20Token = {
  address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  symbol: "STRK",
  decimals: 18,
};
const ETH: Erc20Token = {
  address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  symbol: "ETH",
  decimals: 18,
};
const USDC: Erc20Token = {
  address: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
  symbol: "USDC",
  decimals: 6,
};
const LORDS: Erc20Token = {
  address: "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49",
  symbol: "LORDS",
  decimals: 18,
};
const SURVIVOR: Erc20Token = {
  address: "0x042dd777885ad2c116be96d4d634abc90a26a790ffb5871e037dd5ae7d2ec86b",
  symbol: "SURVIVOR",
  decimals: 18,
};
const CASH: Erc20Token = {
  address: "0x0498edfaf50ca5855666a700c25dd629d577eb9afccdf3b5977aec79aee55ada",
  symbol: "CASH",
  decimals: 18,
};

// Sepolia reuses the canonical STRK/ETH addresses.
const TOKENS: Record<Chain, readonly Erc20Token[]> = {
  mainnet: [STRK, ETH, USDC, LORDS, SURVIVOR, CASH],
  sepolia: [STRK, ETH],
};

export function tokensForChain(chain: Chain): readonly Erc20Token[] {
  return TOKENS[chain];
}

/**
 * Resolve a token reference (symbol like "STRK", or 0x address) to its
 * address + decimals. Unknown addresses hit the contract for decimals.
 */
export async function resolveToken(chain: Chain, ref: string): Promise<Erc20Token> {
  if (!ref.startsWith("0x")) {
    const known = TOKENS[chain].find((t) => t.symbol.toLowerCase() === ref.toLowerCase());
    if (!known) {
      const symbols = TOKENS[chain].map((t) => t.symbol).join(", ");
      throw new Error(`Unknown token symbol "${ref}" on ${chain}. Known: ${symbols}. Or pass a 0x token address.`);
    }
    return known;
  }
  const target = normalizeAddress(ref);
  const known = TOKENS[chain].find((t) => normalizeAddress(t.address) === target);
  if (known) return known;
  const res = await providerFor(chain).callContract(
    { contractAddress: ref, entrypoint: "decimals", calldata: [] },
    "latest",
  );
  return { address: ref, symbol: ref.slice(0, 10) + "…", decimals: Number(BigInt(res[0]!)) };
}

/** "1.5" with 18 decimals → "1500000000000000000" (raw base-unit string). */
export function toRawAmount(human: string, decimals: number): string {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid amount "${human}" — use a plain decimal number.`);
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) throw new Error(`Amount "${human}" has more than ${decimals} decimal places.`);
  return (BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}

export function fromRawAmount(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
