import type { Tournament } from "./tournament.js";
import type { Prize, RewardClaim } from "./prize.js";

/**
 * One row per (player token, tournament) where the token's final rank fell
 * inside a paid position. Multiple placements per tournament are possible
 * when the player owns several tokens entered into the same tournament.
 */
export interface PlayerPlacement {
  tournamentId: string;
  tokenId: string;
  /** 1-indexed rank in the tournament's final leaderboard. */
  position: number;
  /** Token's final score (string to preserve felt252 precision). */
  score: string;
}

/**
 * Aggregate rewards summary for a player address. Computed against current
 * NFT ownership (denshokan), not historical attribution — see PR #243.
 *
 * `tournaments`, `prizes`, and `rewardClaims` are restricted to tournaments
 * where the player has at least one placement. Consumers compute USD values
 * by walking placements + prize/entry-fee data + token prices client-side.
 */
export interface PlayerRewards {
  /** Count of placements that landed on a paid position. */
  wins: number;
  /** Lowest position number across all placements; null when no wins. */
  bestPlacement: number | null;
  placements: PlayerPlacement[];
  /** Tournaments where the player placed (subset of currently-held entries). */
  tournaments: Tournament[];
  /** All sponsored prizes for those tournaments. */
  prizes: Prize[];
  /** All reward claims for those tournaments. */
  rewardClaims: RewardClaim[];
}
