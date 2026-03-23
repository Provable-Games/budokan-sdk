export interface Tournament {
  id: string;
  /** @deprecated Use `id` instead */
  tournamentId: string;
  gameAddress: string;
  createdAt: string;
  createdBy: string;
  creatorTokenId: string | null;
  name: string;
  description: string;
  // Delay fields (raw from contract)
  registrationStartDelay: number | null;
  registrationEndDelay: number | null;
  gameStartDelay: number | null;
  gameEndDelay: number | null;
  submissionDuration: number | null;
  // Computed absolute timestamps (Unix seconds as strings)
  createdAtOnchain: string | null;
  registrationStartTime: string | null;
  registrationEndTime: string | null;
  gameStartTime: string | null;
  gameEndTime: string | null;
  submissionEndTime: string | null;
  // Game config
  settingsId: number | null;
  soulbound: boolean | null;
  paymaster: boolean | null;
  clientUrl: string | null;
  renderer: string | null;
  // Leaderboard config
  leaderboardAscending: boolean | null;
  leaderboardGameMustBeOver: boolean | null;
  // Entry fee summary
  entryFeeToken: string | null;
  entryFeeAmount: string | null;
  hasEntryRequirement: boolean | null;
  // Full structured data (JSONB from API)
  schedule: Schedule | null;
  gameConfig: GameConfig | null;
  entryFee: EntryFee | null;
  entryRequirement: unknown | null;
  leaderboardConfig: LeaderboardConfig | null;
  // Counts
  entryCount: number;
  prizeCount: number;
  submissionCount: number;
  paidPlaces?: number;
  // Prize aggregation (populated when includePrizeSummary is requested)
  prizeAggregation?: Array<{
    tokenAddress: string;
    tokenType: string;
    totalAmount: string;
    nftCount: number;
  }>;
  // Metadata
  metadata: unknown | null;
}

export interface Schedule {
  registrationStartDelay: number;
  registrationEndDelay: number;
  gameStartDelay: number;
  gameEndDelay: number;
  submissionDuration: number;
}

export interface GameConfig {
  gameAddress: string;
  settingsId: number;
  soulbound: boolean;
  paymaster: boolean;
  clientUrl: string | null;
  renderer: string | null;
}

export interface EntryFee {
  tokenAddress: string;
  amount: string;
  tournamentCreatorShare: number;
  gameCreatorShare: number;
  refundShare: number;
  distribution: unknown;
  distributionCount: number;
}

export interface LeaderboardConfig {
  ascending: boolean;
  gameMustBeOver: boolean;
}

export type Phase = "scheduled" | "registration" | "staging" | "live" | "submission" | "finalized";

export interface TournamentListParams {
  gameAddress?: string;
  creator?: string;
  phase?: Phase;
  limit?: number;
  offset?: number;
  sort?: "start_time" | "end_time" | "players" | "created_at";
  fromId?: string;
  excludeIds?: string[];
  whitelistedExtensions?: string[];
  includePrizeSummary?: "summary" | boolean;
}

export interface QualificationEntry {
  tournamentId: string;
  qualificationProof: unknown;
  entryCount: number;
}
