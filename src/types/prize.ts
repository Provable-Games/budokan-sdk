export interface Prize {
  prizeId: string;
  tournamentId: string;
  payoutPosition: number;
  /** Token contract for built-in prizes; `null` for `tokenType === "extension"`. */
  tokenAddress: string | null;
  /**
   * `erc20` / `erc721` are built-in token prizes. `extension` is an external
   * `IPrizeExtension` prize (the #269 path): the token fields below are null
   * and `extensionAddress` / `extensionConfig` are populated instead.
   */
  tokenType: "erc20" | "erc721" | "extension";
  amount: string | null;
  tokenId: string | null;
  distributionType: string | null;
  distributionWeight: number | null;
  /** Populated only when `distributionType === "custom"`. Each entry is a u16
   *  basis-point share summing to 10000, one per paid position. */
  distributionShares: number[] | null;
  distributionCount: number | null;
  sponsorAddress: string;
  /** Extension contract address; only set when `tokenType === "extension"`. */
  extensionAddress: string | null;
  /** Opaque `Span<felt252>` config; only set when `tokenType === "extension"`. */
  extensionConfig: string[] | null;
}

export type Erc20Prize = Prize & {
  tokenType: "erc20";
  tokenAddress: string;
  amount: string;
  tokenId: null;
  extensionAddress: null;
  extensionConfig: null;
};

export type Erc721Prize = Prize & {
  tokenType: "erc721";
  tokenAddress: string;
  amount: null;
  tokenId: string;
  extensionAddress: null;
  extensionConfig: null;
};

export type TokenPrize = Erc20Prize | Erc721Prize;

export type ExtensionPrize = Prize & {
  tokenType: "extension";
  tokenAddress: null;
  amount: null;
  tokenId: null;
  extensionAddress: string;
  extensionConfig: string[] | null;
};

/**
 * Discriminator for `RewardClaim.claimKind`. Picks one of the seven terminal
 * variants of the on-chain `RewardType` enum (Prize::Single, Prize::Distributed,
 * EntryFee::Position / TournamentCreator / GameCreator / Refund / ProtocolFee).
 * The variant-specific fields below are populated only for the kinds that carry
 * them; the three pure-marker kinds (tournament_creator, game_creator,
 * protocol_fee) leave all four nullable fields null.
 */
export type RewardClaimKind =
  | "prize_single"
  | "prize_distributed"
  | "entry_fee_position"
  | "entry_fee_tournament_creator"
  | "entry_fee_game_creator"
  | "entry_fee_protocol_fee"
  | "entry_fee_refund"
  // #269 extension claims: budokan forwards (token_id, params) to the
  // extension, which resolves recipient + eligibility from its own state.
  | "prize_extension"
  | "entry_fee_extension";

export interface RewardClaim {
  tournamentId: string;
  claimKind: RewardClaimKind;
  /** Populated for `prize_single`, `prize_distributed`, `prize_extension`. Stringified u64. */
  prizeId: string | null;
  /** Populated for `prize_distributed`. */
  payoutIndex: number | null;
  /** Populated for `entry_fee_position`. */
  position: number | null;
  /** Populated for `entry_fee_refund`. felt252 hex string of the game token. */
  refundTokenId: string | null;
  /** Game token id, for `prize_extension` / `entry_fee_extension` (Option → null when absent). */
  extensionTokenId: string | null;
  /** Opaque payout/claim params (`Span<felt252>`), for the extension claim kinds. */
  extensionParams: string[] | null;
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
