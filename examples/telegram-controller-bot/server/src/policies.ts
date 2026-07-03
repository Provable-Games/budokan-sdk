// Session policy bundle for Budokan. See ../../ARCHITECTURE.md "Policy list".
//
// Authorizes:
//   - Budokan methods (create_tournament, enter_tournament, claim_reward,
//     submit_score) — the actions the bot executes server-side.
//   - `approve` on the common entry-fee tokens, each with a per-token SPENDING
//     LIMIT (Cartridge enforces a cumulative cap the user sees + approves at
//     /connect). This is what lets paid /enter run entirely in Telegram: the
//     bot approves the exact fee and enters in one in-session multicall, no
//     per-tx popup. The cap bounds what the session can ever spend.

import { CHAINS, extensionAddressFor } from "@provable-games/budokan-sdk";

import type { Chain } from "./chat-state.ts";
import { tokensForChain } from "./catalog/tokens.ts";

export interface PolicyMethod {
  entrypoint: string;
  description?: string;
  /** ERC20 `approve` policies only: the spender authorized (the Budokan contract). */
  spender?: string;
  /** ERC20 `approve` policies only: per-token session spending cap (base units). */
  amount?: string;
}

export interface PolicyContract {
  name?: string;
  /** ERC20 display metadata so the keychain renders a spending-limit card. */
  meta?: { type: "ERC20"; name?: string };
  methods: PolicyMethod[];
}

export interface PolicyBundle {
  contracts: Record<string, PolicyContract>;
}

export function buildSessionPolicies(
  chain: Chain,
  budokanAddressOverride?: string,
): PolicyBundle {
  const budokanAddress = budokanAddressOverride ?? CHAINS[chain]?.budokanAddress;
  if (!budokanAddress) {
    throw new Error(`No Budokan address configured for chain '${chain}'.`);
  }

  const contracts: Record<string, PolicyContract> = {
    [budokanAddress]: {
      name: "Budokan",
      methods: [
        { entrypoint: "create_tournament", description: "Create a Budokan tournament" },
        { entrypoint: "enter_tournament", description: "Enter a tournament" },
        { entrypoint: "claim_reward", description: "Claim a tournament reward" },
        { entrypoint: "submit_score", description: "Submit a tournament score" },
      ],
    },
  };

  // Merkle allowlist validator — `create_tree` registers a round-1 allowlist
  // when bracket merkle gating is on (BRACKET_MERKLE_GATING). Authorized
  // unconditionally so flipping the flag doesn't change the policy set (which
  // would force every session to re-/connect). Skipped only if the chain has no
  // merkle validator deployed. Entry with a proof still uses `enter_tournament`
  // above — the validator's check is an internal call, no separate policy.
  try {
    const merkleValidator = extensionAddressFor(chain, "merkle");
    contracts[merkleValidator] = {
      name: "Merkle Allowlist",
      methods: [
        { entrypoint: "create_tree", description: "Register a bracket round-1 allowlist" },
      ],
    };
  } catch {
    // No merkle validator on this chain — leave it out.
  }

  // Spending limits for the common tokens. Authorizing `approve` with an
  // `amount` makes the keychain show a spending-limit card and enforce the
  // cumulative cap; the bot only ever approves the exact amount it needs at
  // /enter (entry fee) or /add_prize (prize) time.
  for (const token of tokensForChain(chain)) {
    if (!token.spendLimit) continue;
    contracts[token.address] = {
      name: token.symbol,
      meta: { type: "ERC20", name: token.name },
      methods: [
        {
          entrypoint: "approve",
          description: `Pay entry fees & sponsor prizes in ${token.symbol} (up to your spending limit)`,
          // Budokan is the only spender we ever approve (it pulls entry fees +
          // prize escrow). Declaring spender + amount is the non-deprecated form.
          spender: budokanAddress,
          amount: token.spendLimit,
        },
      ],
    };
  }

  return { contracts };
}

type AuthorizedMethod = PolicyMethod & { authorized: boolean };
type ParsedContract = Omit<PolicyContract, "methods"> & { methods: AuthorizedMethod[] };

/**
 * The bundle in the parsed shape @cartridge/controller persists / the keychain
 * URL expects: every method gets `authorized: true`. Mirrors parsePolicies().
 */
export function parsedPoliciesFor(
  chain: Chain,
  budokanAddressOverride?: string,
): { verified: boolean; contracts: Record<string, ParsedContract> } {
  const bundle = buildSessionPolicies(chain, budokanAddressOverride);
  const contracts: Record<string, ParsedContract> = {};
  for (const [addr, group] of Object.entries(bundle.contracts)) {
    contracts[addr] = {
      ...group,
      methods: group.methods.map((m) => ({ ...m, authorized: true })),
    };
  }
  return { verified: false, contracts };
}
