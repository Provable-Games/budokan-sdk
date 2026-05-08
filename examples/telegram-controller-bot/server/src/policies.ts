// Static session policy bundle for Budokan. See ../../ARCHITECTURE.md
// "Policy list" and "Hybrid auth model".
//
// Free actions (create_tournament, claim_reward, submit_score) are sessioned
// — listed here. Paid actions (enter_tournament with a fee) are NOT sessioned
// — they go through the per-tx Mini App flow, so we deliberately do not
// authorize approve() on any token here. The session can never spend the
// user's funds.

import { CHAINS } from "@provable-games/budokan-sdk";

export interface PolicyMethod {
  entrypoint: string;
  description: string;
}

export interface PolicyBundle {
  contracts: Record<string, { methods: PolicyMethod[] }>;
}

/**
 * Same content as buildSessionPolicies, but in the ParsedSessionPolicies
 * shape that @cartridge/controller's NodeBackend persists. Used so we can
 * write the policies file alongside session/signer when the Mini App POSTs
 * back; SessionProvider.probe() reads this to validate the session is
 * authorized for the methods we're about to call.
 *
 * Mirrors the output of @cartridge/controller's parsePolicies():
 *   - { verified: false, contracts: { [addr]: { methods: [{ entrypoint, description, authorized: true }] } } }
 */
export function parsedPoliciesFor(
  chain: "mainnet" | "sepolia",
  budokanAddressOverride?: string,
): { verified: boolean; contracts: Record<string, { methods: Array<{ entrypoint: string; description: string; authorized: boolean }> }> } {
  const bundle = buildSessionPolicies(chain, budokanAddressOverride);
  const contracts: Record<string, { methods: Array<{ entrypoint: string; description: string; authorized: boolean }> }> = {};
  for (const [addr, group] of Object.entries(bundle.contracts)) {
    contracts[addr] = {
      methods: group.methods.map((m) => ({ ...m, authorized: true })),
    };
  }
  return { verified: false, contracts };
}

export function buildSessionPolicies(
  chain: "mainnet" | "sepolia",
  budokanAddressOverride?: string,
): PolicyBundle {
  const budokanAddress = budokanAddressOverride ?? CHAINS[chain]?.budokanAddress;
  if (!budokanAddress) {
    throw new Error(`No Budokan address configured for chain '${chain}'.`);
  }

  return {
    contracts: {
      [budokanAddress]: {
        methods: [
          {
            entrypoint: "create_tournament",
            description: "Create a Budokan tournament",
          },
          {
            entrypoint: "claim_reward",
            description: "Claim a tournament reward",
          },
          {
            entrypoint: "submit_score",
            description: "Submit a tournament score",
          },
        ],
      },
    },
  };
}
