/**
 * Player reward resolution — "which rewards can this player still claim, and
 * what `claim_reward` calls assemble them?"
 *
 * Generalizes the budokan client's `buildPlayerClaimCalls` + `computeEarnings`
 * + `getClaimablePrizes`. Pure: walks placements + prize/entry-fee data +
 * existing claims and returns not-yet-claimed, non-zero rewards plus the
 * `Call`s to claim them (via the tested `buildClaimRewardCall` encoder — so
 * the claim-encoding bug class the SDK was created to kill can't recur).
 *
 * Scope (matches the client): the connected player's own placements only —
 * entry-fee position prizes + sponsored prizes. Creator shares, protocol fee,
 * and per-token refunds are pool/owner concerns, not placement-derived, and
 * are intentionally excluded.
 */

import { buildClaimRewardCall } from "../calldata/index.js";
import type { Call, RewardType } from "../calldata/index.js";
import { entryFeeSplit, entryFeePositionPayout, sponsorPrizePayout } from "../distribution/index.js";
import { isRawTokenPrize } from "../utils/prizes.js";
import type { Tournament } from "../types/tournament.js";
import type { Prize, RewardClaim } from "../types/prize.js";
import type { PlayerPlacement } from "../types/player.js";

export type ClaimableRewardSource =
  | "entry_fee_position"
  | "entry_fee_tournament_creator"
  | "entry_fee_game_creator"
  | "entry_fee_protocol_fee"
  | "entry_fee_refund"
  | "sponsor_single"
  | "sponsor_distributed";

export interface ClaimableReward {
  tournamentId: string;
  /** Human label for UI/telemetry (`tournament.name` or `#id`). */
  tournamentName: string;
  /** Reward descriptor — feed straight to `buildClaimRewardCall` / `buildClaimCalls`. */
  reward: RewardType;
  /** Where the reward comes from (UI grouping / telemetry). */
  source: ClaimableRewardSource;
  /** 1-indexed leaderboard position the reward is for. */
  position: number;
  /** Token contract (ERC20/ERC721). */
  tokenAddress: string | null;
  tokenType: "erc20" | "erc721";
  /** ERC20 amount in smallest units; `undefined` for ERC721 (one NFT). */
  amount?: bigint;
  /** ERC721 token id, when applicable. */
  tokenId?: string | null;
}

export interface GetClaimableRewardsInput {
  placements: PlayerPlacement[];
  tournaments: Tournament[];
  prizes: Prize[];
  /** Existing reward-claim records. Only those with `claimed === true` filter rewards out. */
  existingClaims: RewardClaim[];
}

/**
 * The not-yet-claimed, non-zero rewards across the player's placements.
 *
 * Skips:
 * - already-claimed rewards (would revert),
 * - 0-amount ERC20 slices (contract truncation makes them unclaimable),
 * - creator/protocol/refund shares (not placement-derived).
 */
export function getClaimableRewards(
  input: GetClaimableRewardsInput,
): ClaimableReward[] {
  const tournamentsById = new Map<string, Tournament>();
  for (const t of input.tournaments) tournamentsById.set(t.id, t);

  const prizesByTournament = new Map<string, Prize[]>();
  for (const p of input.prizes) {
    let list = prizesByTournament.get(p.tournamentId);
    if (!list) prizesByTournament.set(p.tournamentId, (list = []));
    list.push(p);
  }

  // O(1) "is this (tournament, reward) already claimed?" lookup.
  const claimedKeys = new Set<string>();
  for (const c of input.existingClaims) {
    if (!c.claimed) continue;
    const key = rewardClaimKey(c);
    if (key) claimedKeys.add(`${c.tournamentId}:${key}`);
  }

  const out: ClaimableReward[] = [];

  for (const placement of input.placements) {
    const tournament = tournamentsById.get(placement.tournamentId);
    if (!tournament) continue;
    const tournamentName = tournament.name || `#${tournament.id}`;
    const pos = placement.position;

    // ---- Entry-fee position prize ----
    const ef = tournament.entryFee;
    const efDistCount = Number(ef?.distributionCount ?? 0);
    if (ef && ef.tokenAddress && efDistCount >= pos) {
      const claimKey = `${placement.tournamentId}:EntryFee.Position.${pos}`;
      if (!claimedKeys.has(claimKey)) {
        const amount = entryFeePositionPayout(
          {
            amount: ef.amount ?? "0",
            entryCount: tournament.entryCount ?? 0,
            tournamentCreatorShare: ef.tournamentCreatorShare,
            gameCreatorShare: ef.gameCreatorShare,
            refundShare: ef.refundShare,
            protocolFeeShare: tournament.protocolFeeShare,
            distribution: ef.distribution,
            distributionCount: efDistCount,
          },
          pos,
        );
        if (amount > 0n) {
          out.push({
            tournamentId: placement.tournamentId,
            tournamentName,
            source: "entry_fee_position",
            position: pos,
            tokenAddress: ef.tokenAddress,
            tokenType: "erc20",
            amount,
            reward: { kind: "entry_fee_position", position: pos },
          });
        }
      }
    }

    // ---- Sponsor prizes at this position ----
    for (const prize of prizesByTournament.get(placement.tournamentId) ?? []) {
      // `isRawTokenPrize` (not `isTokenPrize`): distributed prizes legitimately
      // carry `payoutPosition === 0`, which the hydrated `isTokenPrize` guard
      // would reject — dropping every distributed sponsor reward.
      if (!isRawTokenPrize(prize)) continue;

      const dc = prize.distributionCount ?? 0;
      const pp = prize.payoutPosition ?? 0;
      const isSingle = pp === pos && dc === 0;
      const isDistributed = dc >= pos && pp === 0;
      if (!isSingle && !isDistributed) continue;

      const tokenType: "erc20" | "erc721" =
        prize.tokenType === "erc721" ? "erc721" : "erc20";

      if (isSingle) {
        const claimKey = `${placement.tournamentId}:Prize.Single.${prize.prizeId}`;
        if (claimedKeys.has(claimKey)) continue;
        out.push({
          tournamentId: placement.tournamentId,
          tournamentName,
          source: "sponsor_single",
          position: pos,
          tokenAddress: prize.tokenAddress,
          tokenType,
          amount: tokenType === "erc20" ? BigInt(prize.amount ?? "0") : undefined,
          tokenId: prize.tokenId,
          reward: { kind: "prize_single", prizeId: prize.prizeId },
        });
        continue;
      }

      // Distributed: ERC20 only (the contract only distributes fungibles).
      // The on-chain `payout_index` is 1-indexed and equals the leaderboard
      // position: `_claim_distributed_prize` asserts `payout_index > 0` and
      // reads leaderboard slot `payout_index - 1`. The indexer stores the same
      // 1-indexed value on the claim record (decoder reads it verbatim), so the
      // claim key matches on `pos`, not `pos - 1`.
      const payoutIndex = pos;
      const claimKey = `${placement.tournamentId}:Prize.Distributed.${prize.prizeId}.${payoutIndex}`;
      if (claimedKeys.has(claimKey)) continue;
      const amount = sponsorPrizePayout(prize, pos);
      if (amount <= 0n) continue; // 0-slice → unclaimable on-chain
      out.push({
        tournamentId: placement.tournamentId,
        tournamentName,
        source: "sponsor_distributed",
        position: pos,
        tokenAddress: prize.tokenAddress,
        tokenType: "erc20",
        amount,
        reward: {
          kind: "prize_distributed",
          prizeId: prize.prizeId,
          payoutPosition: payoutIndex,
        },
      });
    }
  }

  return out;
}

/**
 * Turn resolved {@link ClaimableReward}s into `claim_reward` `Call`s for
 * `account.execute([...])`. Order is preserved.
 */
export function buildClaimCalls(
  rewards: ClaimableReward[],
  budokanAddress: string,
): Call[] {
  return rewards.map((r) =>
    buildClaimRewardCall(budokanAddress, {
      tournamentId: r.tournamentId,
      reward: r.reward,
    }),
  );
}

export interface GetDistributableRewardsInput {
  tournament: Tournament;
  prizes: Prize[];
  /** Existing reward-claim records. Only those with `claimed === true` filter rewards out. */
  existingClaims: RewardClaim[];
  /**
   * Entered game-token ids (felt hex or decimal). Required to enumerate the
   * per-token entry-fee refunds; omit to skip refunds (they need the full
   * entrant token list, which isn't derivable from the tournament alone).
   */
  refundTokenIds?: string[];
}

/**
 * Every not-yet-claimed, non-zero reward in a tournament's *whole pool* — the
 * admin "distribute everything" view, vs {@link getClaimableRewards}' single
 * player scope. Covers entry-fee position payouts, the tournament-creator /
 * game-creator / protocol-fee shares, per-token refunds (when `refundTokenIds`
 * is supplied), and sponsored prizes (single + every distributed slot). Feed
 * the result to {@link buildClaimCalls}.
 *
 * All of these are permissionless claims — anyone can trigger them; the
 * contract routes each payout to its rightful recipient (winner, creator, DAO
 * treasury, sponsor). Already-claimed and zero-value entries are skipped.
 */
export function getDistributableRewards(
  input: GetDistributableRewardsInput,
): ClaimableReward[] {
  const t = input.tournament;
  const name = t.name || `#${t.id}`;
  const out: ClaimableReward[] = [];

  // ---- claimed index (whole-pool kinds, not just placement-derived) ----
  let claimedTournamentCreator = false;
  let claimedGameCreator = false;
  let claimedProtocolFee = false;
  const claimedPositions = new Set<number>();
  const claimedRefunds = new Set<string>();
  const claimedSingle = new Set<string>();
  const claimedDistributed = new Set<string>(); // `${prizeId}:${position}`
  for (const c of input.existingClaims) {
    if (!c.claimed) continue;
    switch (c.claimKind) {
      case "entry_fee_tournament_creator": claimedTournamentCreator = true; break;
      case "entry_fee_game_creator": claimedGameCreator = true; break;
      case "entry_fee_protocol_fee": claimedProtocolFee = true; break;
      case "entry_fee_position": if (c.position != null) claimedPositions.add(Number(c.position)); break;
      case "entry_fee_refund": if (c.refundTokenId != null) claimedRefunds.add(idKey(c.refundTokenId)); break;
      case "prize_single": if (c.prizeId != null) claimedSingle.add(String(c.prizeId)); break;
      case "prize_distributed":
        if (c.prizeId != null && c.payoutIndex != null) claimedDistributed.add(`${c.prizeId}:${Number(c.payoutIndex)}`);
        break;
    }
  }

  const erc20Reward = (
    source: ClaimableRewardSource,
    position: number,
    tokenAddress: string,
    amount: bigint,
    reward: RewardType,
    tokenId?: string,
  ): ClaimableReward => ({
    tournamentId: t.id, tournamentName: name, source, position,
    tokenAddress, tokenType: "erc20", amount, tokenId, reward,
  });

  // ---- entry-fee pool ----
  const ef = t.entryFee;
  if (ef && ef.tokenAddress) {
    // protocolFeeShare lives on the entry fee in the client/API shape and is
    // lifted to the tournament over the RPC/viewer source — read both.
    const protocolFeeShare =
      (ef as { protocolFeeShare?: number | null }).protocolFeeShare ??
      t.protocolFeeShare ?? 0;
    const splitInput = {
      amount: ef.amount ?? "0",
      entryCount: t.entryCount ?? 0,
      tournamentCreatorShare: ef.tournamentCreatorShare ?? 0,
      gameCreatorShare: ef.gameCreatorShare ?? 0,
      refundShare: ef.refundShare ?? 0,
      protocolFeeShare,
    };
    const split = entryFeeSplit(splitInput);

    // Position payouts (1-indexed, 1..distributionCount).
    const distCount = Number(ef.distributionCount ?? 0);
    for (let pos = 1; pos <= distCount; pos++) {
      if (claimedPositions.has(pos)) continue;
      const amount = entryFeePositionPayout(
        { ...splitInput, distribution: ef.distribution, distributionCount: distCount },
        pos,
      );
      if (amount <= 0n) continue;
      out.push(erc20Reward("entry_fee_position", pos, ef.tokenAddress, amount, { kind: "entry_fee_position", position: pos }));
    }

    // Fixed shares (one claim each).
    if (!claimedTournamentCreator && split.tournamentCreator > 0n)
      out.push(erc20Reward("entry_fee_tournament_creator", 0, ef.tokenAddress, split.tournamentCreator, { kind: "entry_fee_tournament_creator" }));
    if (!claimedGameCreator && split.gameCreator > 0n)
      out.push(erc20Reward("entry_fee_game_creator", 0, ef.tokenAddress, split.gameCreator, { kind: "entry_fee_game_creator" }));
    if (!claimedProtocolFee && split.protocolFee > 0n)
      out.push(erc20Reward("entry_fee_protocol_fee", 0, ef.tokenAddress, split.protocolFee, { kind: "entry_fee_protocol_fee" }));

    // Per-token refunds: each entrant gets back refundShare% of one entry fee.
    const refundBps = Number(ef.refundShare ?? 0);
    if (refundBps > 0 && input.refundTokenIds?.length) {
      const perToken = (BigInt(ef.amount ?? "0") * BigInt(refundBps)) / 10000n;
      if (perToken > 0n) {
        for (const tokenId of input.refundTokenIds) {
          if (claimedRefunds.has(idKey(tokenId))) continue;
          out.push(erc20Reward("entry_fee_refund", 0, ef.tokenAddress, perToken, { kind: "entry_fee_refund", tokenId }, tokenId));
        }
      }
    }
  }

  // ---- sponsored prizes (whole pool, not position-scoped) ----
  for (const prize of input.prizes) {
    if (!isRawTokenPrize(prize)) continue;
    const dc = prize.distributionCount ?? 0;
    if (dc > 0) {
      for (let pos = 1; pos <= dc; pos++) {
        if (claimedDistributed.has(`${prize.prizeId}:${pos}`)) continue;
        const amount = sponsorPrizePayout(prize, pos);
        if (amount <= 0n) continue;
        out.push(erc20Reward(
          "sponsor_distributed", pos, prize.tokenAddress, amount,
          { kind: "prize_distributed", prizeId: prize.prizeId, payoutPosition: pos },
        ));
      }
    } else {
      if (claimedSingle.has(prize.prizeId)) continue;
      const tokenType: "erc20" | "erc721" = prize.tokenType === "erc721" ? "erc721" : "erc20";
      out.push({
        tournamentId: t.id, tournamentName: name, source: "sponsor_single",
        position: prize.payoutPosition ?? 0, tokenAddress: prize.tokenAddress, tokenType,
        amount: tokenType === "erc20" ? BigInt(prize.amount ?? "0") : undefined,
        tokenId: prize.tokenId,
        reward: { kind: "prize_single", prizeId: prize.prizeId },
      });
    }
  }

  return out;
}

/** Normalize a felt token id (hex or decimal) to a comparable decimal string. */
function idKey(tokenId: string): string {
  try {
    return BigInt(tokenId).toString();
  } catch {
    return String(tokenId);
  }
}

/**
 * Composite key for the three placement-derived claim kinds the player cares
 * about (Prize::Single, Prize::Distributed, EntryFee::Position). Creator,
 * protocol-fee, and refund kinds aren't placement rewards → `null`.
 */
function rewardClaimKey(c: RewardClaim): string | null {
  switch (c.claimKind) {
    case "prize_single":
      return c.prizeId ? `Prize.Single.${c.prizeId}` : null;
    case "prize_distributed":
      return c.prizeId != null && c.payoutIndex != null
        ? `Prize.Distributed.${c.prizeId}.${c.payoutIndex}`
        : null;
    case "entry_fee_position":
      return c.position != null ? `EntryFee.Position.${c.position}` : null;
    default:
      return null;
  }
}
