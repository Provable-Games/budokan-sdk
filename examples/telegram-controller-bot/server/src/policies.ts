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
