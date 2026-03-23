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
  distributionCount: number | null;
  sponsorAddress: string;
}

export interface RewardClaim {
  tournamentId: string;
  rewardType: unknown;
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
