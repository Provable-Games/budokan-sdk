import type {
  EntryRequirement,
  EntryFee,
  Distribution,
} from "@provable-games/metagame-sdk";

// Re-export shared game-components types so consumers can import from budokan-sdk
export type { EntryRequirement, EntryFee, Distribution };

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
  /**
   * Effective protocol-fee rate (basis points) snapshotted for this tournament
   * at creation — the slice of the built-in entry-fee pool routed to the DAO
   * buyback/treasury. `0` when no protocol fee applies. Sourced from the
   * `TournamentCreated` event via the indexer/API; `null` over the RPC/viewer
   * data source (the per-tournament snapshot has no on-chain getter).
   */
  protocolFeeShare: number | null;
  hasEntryRequirement: boolean | null;
  // Full structured data (JSONB from API)
  schedule: Schedule | null;
  gameConfig: GameConfig | null;
  /** Built-in entry fee (EntryFeeKind::BuiltIn). Null for free OR extension-fee tournaments. */
  entryFee: EntryFee | null;
  /**
   * Discriminates the on-chain `EntryFeeKind`: `"builtin"` (see `entryFee`),
   * `"extension"` (see `entryFeeExtension`), or `null` when there's no fee.
   */
  entryFeeKind: "builtin" | "extension" | null;
  /** External entry-fee extension (EntryFeeKind::Extension). Set only when entryFeeKind === "extension". */
  entryFeeExtension: { address: string; config: string[] } | null;
  entryRequirement: EntryRequirement | null;
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
  metadata: Record<string, unknown> | null;
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
  /**
   * Restrict results to this set of tournament IDs. Used by the
   * "My Tournaments" UX where the caller derives ids from currently-owned
   * game tokens (denshokan-sdk) and asks Budokan only for those tournaments.
   * Mutually exclusive with no-filter "show everything" semantics — an empty
   * array yields zero results, not all tournaments.
   */
  tournamentIds?: string[];
  whitelistedExtensions?: string[];
  includePrizeSummary?: "summary" | boolean;
}

/**
 * Discriminator for `QualificationEntry.qualificationKind`. Picks one of
 * the two terminal variants of the on-chain `QualificationProof` enum
 * (NFT, Extension). `nftTokenId` is populated only for `nft`;
 * `extensionConfig` only for `extension`.
 */
export type QualificationKind = "nft" | "extension";

export interface QualificationEntry {
  tournamentId: string;
  qualificationKind: QualificationKind;
  /** Populated when `qualificationKind === "nft"`. u256 token id, decimal string. */
  nftTokenId: string | null;
  /** Populated when `qualificationKind === "extension"`. List of felt252 hex strings. */
  extensionConfig: string[] | null;
  entryCount: number;
}
