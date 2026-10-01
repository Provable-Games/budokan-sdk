// Leaderboard score-submission helpers.
//
// Lifted from the Budokan web client (budokan/client/src/lib/utils/formatting.ts
// `getSubmittableScores`) so any integration — this SDK's consumers, the
// Telegram bot, a Discord bot, an agent — computes submit_score positions the
// same way the official client does, instead of re-deriving (and getting wrong)
// the leaderboard ranking.
//
// The model: a tournament's game tokens, sorted by score, mint block and token ID, and capped
// to the leaderboard size, define the final leaderboard order. A token's
// submit position is simply its 1-indexed rank in that sorted list. Submitting
// the not-yet-submitted tokens in rank order fills the on-chain leaderboard.

import { buildSubmitScoreCall, type Call } from "../calldata/index.js";

/** A single (tokenId → leaderboard position) submission. */
export interface SubmittableScore {
  tokenId: string;
  /** 1-indexed leaderboard position == the token's rank by score. */
  position: number;
}

/**
 * Normalize a token id for comparison. Token ids are felts that can appear as
 * decimal or 0x-hex with varying padding across the indexer / contract / chat
 * input, so compare by numeric value.
 */
function tokenKey(id: string): string {
  try {
    return BigInt(id).toString();
  } catch {
    return id;
  }
}

/**
 * Compute the score submissions for a tournament leaderboard, mirroring the
 * Budokan web client's `getSubmittableScores`.
 *
 * @param rankedTokenIds Tournament game-token ids **sorted by score and tie-break**
 *   and already capped to the leaderboard size (the caller decides the cap —
 *   typically the highest paid prize position). Each token's submit position is
 *   its 1-indexed position in this list.
 * @param submittedTokenIds Token ids already on the leaderboard
 *   (`getTournamentLeaderboard` → `tokenId`, or registrations with
 *   `hasSubmitted`). These are skipped; their positions stay reserved so the
 *   remaining tokens keep their rank-based positions.
 * @returns The not-yet-submitted `{ tokenId, position }` entries, in rank order.
 *   Submit them in this order (a single multicall, or batched) to fill the board.
 */
export function getSubmittableScores(
  rankedTokenIds: string[],
  submittedTokenIds: string[],
): SubmittableScore[] {
  const submitted = new Set(submittedTokenIds.map(tokenKey));
  const out: SubmittableScore[] = [];
  rankedTokenIds.forEach((tokenId, index) => {
    if (!submitted.has(tokenKey(tokenId))) {
      out.push({ tokenId, position: index + 1 });
    }
  });
  return out;
}

/**
 * Build the `submit_score` calls for a batch of submissions (see
 * {@link getSubmittableScores}). Submit them in the returned order.
 */
export function buildSubmitScoreCalls(
  budokanAddress: string,
  tournamentId: string,
  submissions: SubmittableScore[],
): Call[] {
  return submissions.map((s) =>
    buildSubmitScoreCall(budokanAddress, {
      tournamentId,
      tokenId: s.tokenId,
      position: s.position,
    }),
  );
}

/**
 * Sort schema-1 game-token packets using Budokan's leaderboard ordering.
 * Score sorts in the configured direction; ties prefer the earlier mint block,
 * then the lower numerical token ID. Pass IDs from one packet-token tournament.
 * Use before capping the list or calling getSubmittableScores.
 */
export function comparePacketTokenScores(
  a: { tokenId: string; score: bigint | number | string },
  b: { tokenId: string; score: bigint | number | string },
  ascending = false,
): number {
  const scoreA = BigInt(a.score);
  const scoreB = BigInt(b.score);
  if (scoreA !== scoreB) {
    const order = scoreA < scoreB ? -1 : 1;
    return ascending ? order : -order;
  }
  const idA = BigInt(a.tokenId);
  const idB = BigInt(b.tokenId);
  const mintA = (idA >> 32n) & ((1n << 32n) - 1n);
  const mintB = (idB >> 32n) & ((1n << 32n) - 1n);
  if (mintA !== mintB) return mintA < mintB ? -1 : 1;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}
