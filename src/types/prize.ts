// ---- Reward types (from budokan_interfaces) ----

export type RewardType =
  | { Prize: { tokenAddress: string; tokenType: string } }
  | { EntryFee: EntryFeeRewardType };

export type EntryFeeRewardType =
  | { Position: number }
  | { TournamentCreator: Record<string, never> }
  | { GameCreator: Record<string, never> }
  | { Refund: string };

export interface Prize {
  prizeId: string;
  tournamentId: string;
  payoutPosition: number;
  tokenAddress: string;
  tokenType: "erc20" | "erc721";
  amount: string | null;
  tokenId: string | null;
  distributionType: string | null;
  distributionWeight: number | null;
  /** Populated only when `distributionType === "custom"`. Each entry is a u16
   *  basis-point share summing to 10000, one per paid position. */
  distributionShares: number[] | null;
  distributionCount: number | null;
  sponsorAddress: string;
}

export interface RewardClaim {
  tournamentId: string;
  rewardType: RewardType;
  claimed: boolean;
}

export interface PrizeAggregation {
  tokenAddress: string;
  tokenType: string;
  totalAmount: string;
  nftCount: number;
}

export interface RewardClaimSummary {
  totalPrizes: number;
  totalClaimed: number;
  totalUnclaimed: number;
}
