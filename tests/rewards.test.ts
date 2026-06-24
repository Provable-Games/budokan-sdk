import { describe, expect, test } from "bun:test";
import {
  getClaimableRewards,
  getDistributableRewards,
  buildClaimCalls,
} from "../src/rewards/index.ts";
import type { Tournament } from "../src/types/tournament.ts";
import type { Prize, RewardClaim } from "../src/types/prize.ts";
import type { PlayerPlacement } from "../src/types/player.ts";

const tournament = {
  id: "10",
  name: "Cup",
  entryCount: 9,
  protocolFeeShare: 0,
  entryFee: {
    tokenAddress: "0xfee",
    amount: "1000000",
    tournamentCreatorShare: 0,
    gameCreatorShare: 0,
    refundShare: 0,
    distribution: { Uniform: {} },
    distributionCount: 3,
  },
} as unknown as Tournament;

const distributedPrize: Prize = {
  prizeId: "100",
  tournamentId: "10",
  payoutPosition: 0,
  tokenAddress: "0xerc20",
  tokenType: "erc20",
  amount: "900000",
  tokenId: null,
  distributionType: "uniform",
  distributionWeight: null,
  distributionShares: null,
  distributionCount: 3,
  sponsorAddress: "0x0",
  extensionAddress: null,
  extensionConfig: null,
};

const singleNftPrize: Prize = {
  prizeId: "101",
  tournamentId: "10",
  payoutPosition: 1,
  tokenAddress: "0xnft",
  tokenType: "erc721",
  amount: null,
  tokenId: "7",
  distributionType: null,
  distributionWeight: null,
  distributionShares: null,
  distributionCount: null,
  sponsorAddress: "0x0",
  extensionAddress: null,
  extensionConfig: null,
};

const placements: PlayerPlacement[] = [
  { tournamentId: "10", tokenId: "0x1", position: 1, score: "100" },
];

describe("getClaimableRewards", () => {
  test("resolves entry-fee position + distributed + single rewards", () => {
    const rewards = getClaimableRewards({
      placements,
      tournaments: [tournament],
      prizes: [distributedPrize, singleNftPrize],
      existingClaims: [],
    });

    const bySource = Object.fromEntries(rewards.map((r) => [r.source, r]));

    // entry-fee position 1: pool = 9_000_000, uniform/3 ≈ 33.33%
    expect(bySource.entry_fee_position).toBeDefined();
    expect(bySource.entry_fee_position!.reward).toEqual({
      kind: "entry_fee_position",
      position: 1,
    });
    expect(bySource.entry_fee_position!.amount).toBeGreaterThan(0n);

    // distributed sponsor erc20: 900_000 * 33.33% ≈ 300_000
    // payout index is 1-indexed = leaderboard position (contract asserts > 0).
    expect(bySource.sponsor_distributed!.reward).toEqual({
      kind: "prize_distributed",
      prizeId: "100",
      payoutPosition: 1,
    });
    expect(bySource.sponsor_distributed!.amount).toBeGreaterThan(0n);

    // single erc721 prize at position 1
    expect(bySource.sponsor_single!.reward).toEqual({
      kind: "prize_single",
      prizeId: "101",
    });
    expect(bySource.sponsor_single!.tokenType).toBe("erc721");
    expect(bySource.sponsor_single!.amount).toBeUndefined();
  });

  test("excludes already-claimed rewards", () => {
    const claimed: RewardClaim = {
      tournamentId: "10",
      claimKind: "entry_fee_position",
      prizeId: null,
      payoutIndex: null,
      position: 1,
      refundTokenId: null,
      extensionTokenId: null,
      extensionParams: null,
      claimed: true,
    };
    const rewards = getClaimableRewards({
      placements,
      tournaments: [tournament],
      prizes: [distributedPrize, singleNftPrize],
      existingClaims: [claimed],
    });
    expect(rewards.find((r) => r.source === "entry_fee_position")).toBeUndefined();
    // others still present
    expect(rewards.some((r) => r.source === "sponsor_distributed")).toBe(true);
  });

  test("excludes a claimed distributed prize keyed by 1-indexed payout index", () => {
    // Claim record carries payoutIndex === position (1-indexed), as the
    // contract emits and the indexer decodes it. The placement-side key must
    // use the same 1-indexed value to dedupe correctly.
    const claimed: RewardClaim = {
      tournamentId: "10",
      claimKind: "prize_distributed",
      prizeId: "100",
      payoutIndex: 1, // position 1, NOT 0
      position: null,
      refundTokenId: null,
      extensionTokenId: null,
      extensionParams: null,
      claimed: true,
    };
    const rewards = getClaimableRewards({
      placements,
      tournaments: [tournament],
      prizes: [distributedPrize, singleNftPrize],
      existingClaims: [claimed],
    });
    expect(rewards.find((r) => r.source === "sponsor_distributed")).toBeUndefined();
  });

  test("skips placements with no matching tournament", () => {
    const rewards = getClaimableRewards({
      placements: [{ tournamentId: "999", tokenId: "0x1", position: 1, score: "0" }],
      tournaments: [tournament],
      prizes: [],
      existingClaims: [],
    });
    expect(rewards).toEqual([]);
  });
});

describe("buildClaimCalls", () => {
  test("each reward becomes a claim_reward call to the budokan address", () => {
    const rewards = getClaimableRewards({
      placements,
      tournaments: [tournament],
      prizes: [distributedPrize, singleNftPrize],
      existingClaims: [],
    });
    const calls = buildClaimCalls(rewards, "0xbudokan");
    expect(calls.length).toBe(rewards.length);
    for (const c of calls) {
      expect(c.contractAddress).toBe("0xbudokan");
      expect(c.entrypoint).toBe("claim_reward");
      expect(c.calldata[0]).toBe("0xa"); // tournament_id 10
    }
  });
});

describe("getDistributableRewards", () => {
  const poolTournament = {
    id: "10",
    name: "Cup",
    entryCount: 10,
    protocolFeeShare: 300, // 3%
    entryFee: {
      tokenAddress: "0xfee",
      amount: "1000000", // total pool 10_000_000
      tournamentCreatorShare: 1000, // 10%
      gameCreatorShare: 500, // 5%
      refundShare: 500, // 5%
      distribution: { Uniform: {} },
      distributionCount: 3,
    },
  } as unknown as Tournament;

  test("enumerates the whole pool: positions + creator/game/protocol shares + sponsored", () => {
    const rewards = getDistributableRewards({
      tournament: poolTournament,
      prizes: [distributedPrize, singleNftPrize],
      existingClaims: [],
    });
    const sources = rewards.map((r) => r.source);
    // 3 entry-fee positions
    expect(sources.filter((s) => s === "entry_fee_position").length).toBe(3);
    // fixed shares (all non-zero)
    expect(sources).toContain("entry_fee_tournament_creator");
    expect(sources).toContain("entry_fee_game_creator");
    expect(sources).toContain("entry_fee_protocol_fee");
    // sponsored: 3 distributed slots + 1 single nft
    expect(sources.filter((s) => s === "sponsor_distributed").length).toBe(3);
    expect(sources.filter((s) => s === "sponsor_single").length).toBe(1);

    // creator share = 10% of 10_000_000
    const creator = rewards.find((r) => r.source === "entry_fee_tournament_creator");
    expect(creator!.amount).toBe(1_000_000n);
    expect(creator!.reward).toEqual({ kind: "entry_fee_tournament_creator" });
  });

  test("position payout reserves the protocol fee", () => {
    const rewards = getDistributableRewards({
      tournament: poolTournament,
      prizes: [],
      existingClaims: [],
    });
    // available = 10000 - 1000 - 500 - 500 - 300 = 7700 bps of 10_000_000 = 7_700_000
    // uniform / 3 → ~2_566_666 for position 1 (dust to pos 1)
    const pos1 = rewards.find(
      (r) => r.source === "entry_fee_position" && r.position === 1,
    );
    expect(pos1!.amount! > 2_560_000n && pos1!.amount! < 2_570_000n).toBe(true);
  });

  test("excludes already-claimed pool rewards", () => {
    const rewards = getDistributableRewards({
      tournament: poolTournament,
      prizes: [distributedPrize],
      existingClaims: [
        {
          tournamentId: "10", claimKind: "entry_fee_protocol_fee",
          prizeId: null, payoutIndex: null, position: null, refundTokenId: null,
          extensionTokenId: null, extensionParams: null, claimed: true,
        },
        {
          tournamentId: "10", claimKind: "prize_distributed", prizeId: "100",
          payoutIndex: 1, position: null, refundTokenId: null,
          extensionTokenId: null, extensionParams: null, claimed: true,
        },
      ],
    });
    expect(rewards.some((r) => r.source === "entry_fee_protocol_fee")).toBe(false);
    // distributed slot 1 claimed; slots 2 and 3 remain
    const dist = rewards.filter((r) => r.source === "sponsor_distributed");
    expect(dist.map((r) => r.position).sort()).toEqual([2, 3]);
  });

  test("enumerates per-token refunds only when token ids are supplied", () => {
    const without = getDistributableRewards({
      tournament: poolTournament, prizes: [], existingClaims: [],
    });
    expect(without.some((r) => r.source === "entry_fee_refund")).toBe(false);

    const withIds = getDistributableRewards({
      tournament: poolTournament, prizes: [], existingClaims: [],
      refundTokenIds: ["0x1", "0x2"],
    });
    const refunds = withIds.filter((r) => r.source === "entry_fee_refund");
    expect(refunds.length).toBe(2);
    // per-token refund = 5% of one entry fee (1_000_000) = 50_000
    expect(refunds[0]!.amount).toBe(50_000n);
  });
});
