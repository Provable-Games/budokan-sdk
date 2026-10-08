/**
 * On-chain brackets (budokan `packages/bracket`) as served by the Budokan API's `/brackets`
 * routes, which the bracket indexer fills. Amounts are decimal strings, times unix seconds.
 * Match tournaments are ordinary tournaments: fetch them with `getTournament(s)`.
 */
export interface IndexedBracket {
  contractAddress: string;
  id: string;
  creator: string;
  gameAddress: string;
  /** Seats; a power of two, or 0 for an uncapped bracket. */
  capacity: number;
  settingsId: number;
  /** Entry fee in the fee token's smallest unit (u256 as a decimal string; "0" = free). */
  entryFee: string;
  feeToken: string;
  registrationDeadline: number;
  gameDuration: number;
  submissionDuration: number;
  leaderboardAscending: boolean;
  gameMustBeOver: boolean;
  prizeDistributionCount: number;
  /** Contract status: 0 registering, 1 assigning, 2 building, 3 running, 4 complete, 5 cancelled. */
  status: number;
  attemptsPerPlayer: number;
  playStart: number;
  requiredRegistrants: number;
  registrationAllowlistCount: number;
  protocolFeeBps: number;
  registrantCount: number;
  /** Seated power-of-two field (0 until drawn). */
  field: number;
  matchesBuilt: number;
  /** Creator-imported roster: no registration or entry payment. */
  freeRoster: boolean;
  /**
   * Invitations the creator declared (scaled brackets). Absent from API servers older than
   * budokan #349; treat absent as ready with nothing expected beyond the imported count.
   */
  allowlistExpected?: number;
  /** False while the creator is still uploading invitations: registration stays closed. */
  allowlistReady?: boolean;
  /** Resumable draw progress; null on contract classes without `assignment_progress`. */
  assignmentCompleted?: number | null;
  assignmentTotal?: number | null;
  createdAtBlock: string;
  updatedAtBlock: string;
  /** Match tournament ids in match-index order (round 1 first). */
  tournamentIds: string[];
}

export interface IndexedBracketDetail extends IndexedBracket {
  /** Round-1 seats; seats 2k and 2k+1 play round-1 match k. Empty until drawn. */
  seats: string[];
  matches: Array<{ matchIndex: number; tournamentId: string }>;
}

export interface BracketListParams {
  gameAddress?: string;
  /** Contract status values to include. */
  status?: number[];
  contractAddress?: string;
  limit?: number;
  offset?: number;
}

export interface BracketRegistration {
  registrationIndex: number;
  player: string;
  refunded: boolean;
  blockNumber: string;
  txHash: string | null;
}

export interface PlayerBracketRegistration {
  contractAddress: string;
  bracketId: string;
  registrationIndex: number;
  refunded: boolean;
  blockNumber: string;
  txHash: string | null;
}
