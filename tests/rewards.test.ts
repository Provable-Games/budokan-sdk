import { describe, expect, test } from "bun:test";
import { getClaimableRewards, buildClaimCalls } from "../src/rewards/index.ts";
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
