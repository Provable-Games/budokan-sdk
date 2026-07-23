// Token resolution for tool inputs ("5 STRK" → raw base units). The catalog
// and decimal math live in the SDK (`findKnownToken`, `toRawAmount`,
// `fromRawAmount`); this wrapper only adds the on-chain `decimals()` fallback
// for tokens outside the catalog, which needs an RPC and so can't be in the
// SDK's pure token module.

import {
  findKnownToken,
  knownTokensForChain,
  type KnownToken,
} from "@provable-games/budokan-sdk";
import { providerFor } from "./wallet.ts";
import type { Chain } from "./config.ts";

export { toRawAmount, fromRawAmount } from "@provable-games/budokan-sdk";

export interface Erc20Token {
  address: string;
  symbol: string;
  decimals: number;
}

export function tokensForChain(chain: Chain): readonly KnownToken[] {
  return knownTokensForChain(chain);
}

/**
 * Resolve a token reference (symbol like "STRK", or 0x address) to its
 * address + decimals. Unknown addresses hit the contract for decimals.
 */
export async function resolveToken(chain: Chain, ref: string): Promise<Erc20Token> {
  const known = findKnownToken(chain, ref);
  if (known) return known;
  if (!ref.startsWith("0x")) {
    const symbols = knownTokensForChain(chain)
      .map((t) => t.symbol)
      .join(", ");
    throw new Error(`Unknown token symbol "${ref}" on ${chain}. Known: ${symbols}. Or pass a 0x token address.`);
  }
  const res = await providerFor(chain).callContract(
    { contractAddress: ref, entrypoint: "decimals", calldata: [] },
    "latest",
  );
  return { address: ref, symbol: ref.slice(0, 10) + "…", decimals: Number(BigInt(res[0]!)) };
}
