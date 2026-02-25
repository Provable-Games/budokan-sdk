export interface Prize {
  prizeId: string;
  tournamentId: string;
  payoutPosition: number;
  tokenAddress: string;
  tokenType: unknown;
  sponsorAddress: string;
}

export interface RewardClaim {
  tournamentId: string;
  rewardType: unknown;
  claimed: boolean;
}
