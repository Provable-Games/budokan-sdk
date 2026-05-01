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

/**
 * Discriminator for `RewardClaim.claimKind`. Picks one of the six terminal
 * variants of the on-chain `RewardType` enum (Prize::Single, Prize::Distributed,
 * EntryFee::Position / TournamentCreator / GameCreator / Refund). The
 * variant-specific fields below are populated only for the kinds that carry
 * them; the two pure-marker creator kinds leave all four nullable fields null.
 */
export type RewardClaimKind =
  | "prize_single"
  | "prize_distributed"
  | "entry_fee_position"
  | "entry_fee_tournament_creator"
  | "entry_fee_game_creator"
  | "entry_fee_refund";

export interface RewardClaim {
  tournamentId: string;
  claimKind: RewardClaimKind;
  /** Populated for `prize_single` and `prize_distributed`. Stringified u64. */
  prizeId: string | null;
  /** Populated for `prize_distributed`. */
  payoutIndex: number | null;
  /** Populated for `entry_fee_position`. */
  position: number | null;
  /** Populated for `entry_fee_refund`. felt252 hex string of the game token. */
  refundTokenId: string | null;
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
