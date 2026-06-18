import { describe, expect, test } from "bun:test";
import { hash } from "starknet";
import {
  buildClaimRewardCall,
  buildEnterTournamentCall,
  buildErc20ApproveCall,
  buildSubmitScoreCall,
  buildCreateTournamentCall,
  parseTournamentIdFromReceipt,
  type CreateTournamentArgs,
} from "../src/calldata/index.ts";

const BUDOKAN = "0x1234";

describe("buildErc20ApproveCall", () => {
  test("encodes approve(spender, u256 amount)", () => {
    const call = buildErc20ApproveCall("0xtoken", "0xspender", "1000");
    expect(call.contractAddress).toBe("0xtoken");
    expect(call.entrypoint).toBe("approve");
    // spender felt + u256 (low, high) = 3 felts
    expect(call.calldata).toHaveLength(3);
  });
});

describe("buildEnterTournamentCall", () => {
  test("player_name is a plain felt252 when provided", () => {
    const call = buildEnterTournamentCall(BUDOKAN, {
      tournamentId: "5",
      playerAddress: "0xabc",
      playerName: "ab", // ASCII 0x6162
    });
    // [id, name_felt, address, qual_tag(None=0x1), salt, meta]
    expect(call.calldata[1]).toBe("0x6162");
    expect(call.calldata[2]).toBe("0xabc");
    expect(call.calldata[3]).toBe("0x1"); // qualification None
  });

  test("player_name defaults to empty felt (0x0) when omitted", () => {
    const call = buildEnterTournamentCall(BUDOKAN, {
      tournamentId: "5",
      playerAddress: "0xabc",
    });
    // [id, name_felt(0x0), address, qual_tag(None=0x1), salt, meta]
    expect(call.calldata[1]).toBe("0x0");
    expect(call.calldata[2]).toBe("0xabc");
    expect(call.calldata[3]).toBe("0x1"); // qualification None
    expect(call.calldata[4]).toBe("0x0"); // default salt
    expect(call.calldata[5]).toBe("0x0"); // default metadata_value
  });
});

describe("buildClaimRewardCall enum tags", () => {
  const cases: Array<[Parameters<typeof buildClaimRewardCall>[1]["reward"], string[]]> = [
    [{ kind: "prize_single", prizeId: "7" }, ["0x0", "0x0", "0x7"]],
    [
      { kind: "prize_distributed", prizeId: "7", payoutPosition: 2 },
      ["0x0", "0x1", "0x7", "0x2"],
    ],
    [{ kind: "entry_fee_position", position: 3 }, ["0x1", "0x0", "0x3"]],
    [{ kind: "entry_fee_tournament_creator" }, ["0x1", "0x1"]],
    [{ kind: "entry_fee_game_creator" }, ["0x1", "0x2"]],
    [{ kind: "entry_fee_refund", tokenId: "9" }, ["0x1", "0x3", "0x9"]],
  ];
  for (const [reward, expected] of cases) {
    test(reward.kind, () => {
      const call = buildClaimRewardCall(BUDOKAN, { tournamentId: "1", reward });
      // calldata[0] is the tournament id; the reward felts follow
      expect(call.calldata.slice(1)).toEqual(expected);
    });
  }
});

describe("buildSubmitScoreCall", () => {
  test("compiles tournament_id, token_id, position", () => {
    const call = buildSubmitScoreCall(BUDOKAN, {
      tournamentId: "1",
      tokenId: "42",
      position: 1,
    });
    expect(call.entrypoint).toBe("submit_score");
    expect(call.calldata).toEqual(["1", "42", "1"]);
  });
});

describe("buildCreateTournamentCall", () => {
  const base: CreateTournamentArgs = {
    creatorRewardsAddress: "0xcreator",
    name: "My Cup",
    description: "A multi-felt ByteArray description that exceeds 31 bytes.",
    gameAddress: "0xgame",
    settingsId: 0,
    schedule: {
      registrationStartDelay: 0,
      registrationEndDelay: 3600,
      gameStartDelay: 0,
      gameEndDelay: 7200,
      submissionDuration: 86400,
    },
    leaderboard: { ascending: false, gameMustBeOver: false },
  };

  test("compiles a free/open tournament without throwing", () => {
    const call = buildCreateTournamentCall(BUDOKAN, base);
    expect(call.entrypoint).toBe("create_tournament");
    expect(call.calldata.length).toBeGreaterThan(0);
  });

  test("compiles with entry fee + token requirement", () => {
    const call = buildCreateTournamentCall(BUDOKAN, {
      ...base,
      entryFee: {
        tokenAddress: "0xtoken",
        amount: "1000",
        tournamentCreatorShare: 1000,
        gameCreatorShare: 500,
        refundShare: 0,
        distribution: { kind: "linear", weight: 10 },
        distributionCount: 3,
      },
      entryRequirement: {
        entryLimit: 1,
        type: { kind: "token", tokenAddress: "0xgate" },
      },
    });
    expect(call.calldata.length).toBeGreaterThan(0);
  });
});

describe("parseTournamentIdFromReceipt", () => {
  const selector = hash.getSelectorFromName("TournamentCreated");

  test("returns the id as a lossless bigint", () => {
    const receipt = {
      events: [
        { from_address: BUDOKAN, keys: [selector, "0x2a"] },
      ],
    };
    expect(parseTournamentIdFromReceipt(receipt, BUDOKAN)).toBe(42n);
  });

  test("does not truncate ids above Number.MAX_SAFE_INTEGER", () => {
    const big = (2n ** 53n + 5n);
    const receipt = {
      events: [
        { from_address: BUDOKAN, keys: [selector, "0x" + big.toString(16)] },
      ],
    };
    expect(parseTournamentIdFromReceipt(receipt, BUDOKAN)).toBe(big);
  });

  test("matches selector + address despite zero-padding / casing", () => {
    const paddedSelector = "0x0" + selector.slice(2);
    const receipt = {
      events: [
        { from_address: "0x0001234", keys: [paddedSelector, "0x7"] },
      ],
    };
    expect(parseTournamentIdFromReceipt(receipt, "0x1234")).toBe(7n);
  });

  test("returns undefined when no matching event", () => {
    const receipt = {
      events: [
        { from_address: "0xother", keys: [selector, "0x1"] },
        { from_address: BUDOKAN, keys: ["0xdeadbeef", "0x1"] },
      ],
    };
    expect(parseTournamentIdFromReceipt(receipt, BUDOKAN)).toBeUndefined();
  });

  test("returns undefined for empty/absent events", () => {
    expect(parseTournamentIdFromReceipt({}, BUDOKAN)).toBeUndefined();
    expect(parseTournamentIdFromReceipt({ events: [] }, BUDOKAN)).toBeUndefined();
  });
});
