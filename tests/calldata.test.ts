import { describe, expect, test } from "bun:test";
import { hash } from "starknet";
import {
  buildAddPrizeCall,
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

describe("buildEnterTournamentCall (#264/#269 8-param shape)", () => {
  test("player_name + player_address Some when provided", () => {
    const call = buildEnterTournamentCall(BUDOKAN, {
      tournamentId: "5",
      playerAddress: "0xabc",
      playerName: "ab", // ASCII 0x6162
    });
    // [id, name(Some 0x0,felt), addr(Some 0x0,felt), qualifier(None 0x1),
    //  qualification(None 0x1), entry_fee_pay_params(None 0x1), salt, meta]
    expect(call.calldata).toEqual([
      "0x5", // tournament_id
      "0x0", "0x6162", // player_name Some("ab")
      "0x0", "0xabc", // player_address Some
      "0x1", // qualifier None
      "0x1", // qualification None
      "0x1", // entry_fee_pay_params None
      "0x0", // salt
      "0x0", // metadata_value
    ]);
  });

  test("player_name + player_address None when omitted", () => {
    const call = buildEnterTournamentCall(BUDOKAN, { tournamentId: "5" });
    expect(call.calldata).toEqual([
      "0x5", // tournament_id
      "0x1", // player_name None
      "0x1", // player_address None
      "0x1", // qualifier None
      "0x1", // qualification None
      "0x1", // entry_fee_pay_params None
      "0x0", // salt
      "0x0", // metadata_value
    ]);
  });

  test("extension qualification proof (tournament validator) encodes Some/Extension/span", () => {
    const call = buildEnterTournamentCall(BUDOKAN, {
      tournamentId: "9",
      playerAddress: "0xW",
      // entrant won feeder tournament 7 with token 0x123 at position 1
      qualification: { kind: "extension", data: ["7", "0x123", "1"] },
    });
    expect(call.calldata).toEqual([
      "0x9", // tournament_id
      "0x1", // player_name None
      "0x0", "0xW", // player_address Some
      "0x1", // qualifier None
      "0x0", // qualification Some
      "0x1", // QualificationProof::Extension (variant 1)
      "0x3", "0x7", "0x123", "0x1", // Span<felt252> [len, tid, tokenId, position]
      "0x1", // entry_fee_pay_params None
      "0x0", // salt
      "0x0", // metadata_value
    ]);
  });

  test("nft qualification proof encodes Some/NFT/u256", () => {
    const call = buildEnterTournamentCall(BUDOKAN, {
      tournamentId: "9",
      qualification: { kind: "nft", tokenId: "5" },
    });
    expect(call.calldata).toEqual([
      "0x9", // tournament_id
      "0x1", // player_name None
      "0x1", // player_address None
      "0x1", // qualifier None
      "0x0", // qualification Some
      "0x0", // QualificationProof::NFT (variant 0)
      "0x5", "0x0", // NFTQualification { token_id: u256 } → low, high
      "0x1", // entry_fee_pay_params None
      "0x0", // salt
      "0x0", // metadata_value
    ]);
  });

  test("qualifier Some when provided", () => {
    const call = buildEnterTournamentCall(BUDOKAN, {
      tournamentId: "5",
      playerAddress: "0xabc",
      qualifier: "0xq",
    });
    // name None (1 felt) → addr Some(0x0,0xabc) → qualifier Some(0x0,0xq)
    expect(call.calldata.slice(1)).toEqual([
      "0x1", // player_name None
      "0x0", "0xabc", // player_address Some
      "0x0", "0xq", // qualifier Some
      "0x1", // qualification None
      "0x1", // entry_fee_pay_params None
      "0x0", "0x0", // salt, metadata
    ]);
  });
});

describe("buildClaimRewardCall enum tags", () => {
  // Tags: RewardType{Prize=0,EntryFee=1} → PrizeClaim/EntryFeeClaim
  // {Token=0,Extension=1} → inner type tag.
  const cases: Array<[Parameters<typeof buildClaimRewardCall>[1]["reward"], string[]]> = [
    [{ kind: "prize_single", prizeId: "7" }, ["0x0", "0x0", "0x0", "0x7"]],
    [
      { kind: "prize_distributed", prizeId: "7", payoutPosition: 2 },
      ["0x0", "0x0", "0x1", "0x7", "0x2"],
    ],
    [{ kind: "entry_fee_position", position: 3 }, ["0x1", "0x0", "0x0", "0x3"]],
    [{ kind: "entry_fee_tournament_creator" }, ["0x1", "0x0", "0x1"]],
    [{ kind: "entry_fee_game_fee" }, ["0x1", "0x0", "0x2"]],
    [{ kind: "entry_fee_refund", tokenId: "9" }, ["0x1", "0x0", "0x3", "0x9"]],
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
        gameFeeShare: 500,
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

  test("defaults soulbound and paymaster to false, in different fields", () => {
    const def = buildCreateTournamentCall(BUDOKAN, base).calldata;
    const sb = buildCreateTournamentCall(BUDOKAN, { ...base, soulbound: true }).calldata;
    const pm = buildCreateTournamentCall(BUDOKAN, { ...base, paymaster: true }).calldata;
    const soulboundIdx = def.findIndex((v, i) => v !== sb[i]);
    const paymasterIdx = def.findIndex((v, i) => v !== pm[i]);
    expect(soulboundIdx).toBeGreaterThan(-1);
    expect(paymasterIdx).toBeGreaterThan(-1);
    // Distinct fields — a shared index would mean one flag is overwriting the
    // other rather than each occupying its own felt.
    expect(soulboundIdx).not.toBe(paymasterIdx);
    expect(BigInt(def[soulboundIdx]!)).toBe(0n);
    expect(BigInt(def[paymasterIdx]!)).toBe(0n);
  });

  test("soulbound:true flips exactly one calldata field from 0 to 1", () => {
    const def = buildCreateTournamentCall(BUDOKAN, base).calldata;
    const sb = buildCreateTournamentCall(BUDOKAN, { ...base, soulbound: true }).calldata;
    expect(sb.length).toBe(def.length);
    const diffs = def.map((v, i) => (v === sb[i] ? -1 : i)).filter((i) => i !== -1);
    expect(diffs).toHaveLength(1);
    expect(BigInt(sb[diffs[0]!]!)).toBe(1n);
  });

  test("compiles a custom per-position distribution (Span<u16> basis points)", () => {
    const call = buildCreateTournamentCall(BUDOKAN, {
      ...base,
      entryFee: {
        tokenAddress: "0xtoken",
        amount: "1000",
        tournamentCreatorShare: 0,
        gameFeeShare: 500,
        refundShare: 0,
        distribution: { kind: "custom", weights: [3000, 2000, 1400, 1000, 800, 600, 400, 300, 300, 200] },
        distributionCount: 10,
      },
    });
    expect(call.calldata.length).toBeGreaterThan(0);
  });

  const customFee = (weights: number[], distributionCount: number) => ({
    tokenAddress: "0xtoken",
    amount: "1000",
    tournamentCreatorShare: 0,
    gameFeeShare: 500,
    refundShare: 0,
    distribution: { kind: "custom" as const, weights },
    distributionCount,
  });

  test("rejects a custom distribution that does not sum to 10000 bps", () => {
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, { ...base, entryFee: customFee([5000, 4000], 2) }),
    ).toThrow(/sum to 10000/);
  });

  test("rejects a custom distribution whose length != distributionCount", () => {
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, { ...base, entryFee: customFee([6000, 4000], 3) }),
    ).toThrow(/weights but.*distributionCount/);
  });

  test("rejects out-of-range custom weights", () => {
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, { ...base, entryFee: customFee([10001, -1], 2) }),
    ).toThrow(/basis points/);
  });

  test("rejects oversized / non-ASCII names with a clear error", () => {
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, { ...base, name: "x".repeat(32) }),
    ).toThrow(/Tournament name.*31/);
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, { ...base, name: "Cup 🏆" }),
    ).toThrow(/Tournament name must be ASCII/);
    // 31 chars exactly is fine.
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, { ...base, name: "y".repeat(31) }),
    ).not.toThrow();
  });

  test("rejects invalid entry fees at build time", () => {
    const fee = {
      tokenAddress: "0xtoken",
      amount: "1000",
      tournamentCreatorShare: 1000,
      gameFeeShare: 500,
      refundShare: 0,
      distribution: { kind: "linear", weight: 10 } as const,
      distributionCount: 3,
    };
    // Human-decimal amount (forgot toRawAmount) and zero amount.
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, { ...base, entryFee: { ...fee, amount: "1.5" } }),
    ).toThrow(/toRawAmount/);
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, { ...base, entryFee: { ...fee, amount: "0" } }),
    ).toThrow(/positive/);
    // Shares over 100% in aggregate, or out of range individually.
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, {
        ...base,
        entryFee: { ...fee, tournamentCreatorShare: 6000, gameFeeShare: 5000 },
      }),
    ).toThrow(/exceed 100%/);
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, {
        ...base,
        entryFee: { ...fee, refundShare: 10001 },
      }),
    ).toThrow(/0–10000/);
    expect(() =>
      buildCreateTournamentCall(BUDOKAN, {
        ...base,
        entryFee: { ...fee, distributionCount: 0 },
      }),
    ).toThrow(/distributionCount/);
  });
});

describe("buildAddPrizeCall", () => {
  test("erc20 single (winner-takes-all) compiles", () => {
    const call = buildAddPrizeCall(BUDOKAN, {
      tournamentId: "1",
      prize: {
        kind: "token",
        tokenAddress: "0xtoken",
        tokenType: { kind: "erc20", amount: "1000" },
        position: 1,
      },
    });
    expect(call.entrypoint).toBe("add_prize");
    expect(call.calldata.length).toBeGreaterThan(0);
  });

  test("erc20 distributed compiles with distributionCount", () => {
    const call = buildAddPrizeCall(BUDOKAN, {
      tournamentId: "1",
      prize: {
        kind: "token",
        tokenAddress: "0xtoken",
        tokenType: {
          kind: "erc20",
          amount: "1000",
          distribution: { kind: "linear", weight: 10 },
          distributionCount: 3,
        },
      },
    });
    expect(call.calldata.length).toBeGreaterThan(0);
  });

  test("erc20 distribution without distributionCount throws", () => {
    expect(() =>
      buildAddPrizeCall(BUDOKAN, {
        tournamentId: "1",
        prize: {
          kind: "token",
          tokenAddress: "0xtoken",
          tokenType: {
            kind: "erc20",
            amount: "1000",
            distribution: { kind: "linear", weight: 10 },
          },
        },
      }),
    ).toThrow(/distributionCount is required/);
  });

  test("erc721 prize compiles", () => {
    const call = buildAddPrizeCall(BUDOKAN, {
      tournamentId: "1",
      prize: {
        kind: "token",
        tokenAddress: "0xnft",
        tokenType: { kind: "erc721", tokenId: "42" },
      },
    });
    expect(call.calldata.length).toBeGreaterThan(0);
  });

  test("extension prize compiles", () => {
    const call = buildAddPrizeCall(BUDOKAN, {
      tournamentId: "1",
      prize: { kind: "extension", address: "0xext", config: ["0x1", "0x2"] },
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

describe("pushRewardTypeFelts fall-through", () => {
  // The retired kind is the live case: a descriptor persisted before the
  // `entry_fee_game_creator` -> `entry_fee_game_fee` rename, or any JS caller,
  // used to build calldata carrying only the tournament id and revert opaquely
  // on chain. TypeScript cannot rule that out at the boundary, so the runtime
  // has to.
  test("throws on a retired or unknown reward kind", () => {
    expect(() =>
      buildClaimRewardCall(BUDOKAN, {
        tournamentId: "1",
        reward: { kind: "entry_fee_game_creator" } as never,
      }),
    ).toThrow(/Unsupported reward kind: entry_fee_game_creator/);
  });

  test("still builds the renamed kind", () => {
    const call = buildClaimRewardCall(BUDOKAN, {
      tournamentId: "1",
      reward: { kind: "entry_fee_game_fee" },
    });
    expect(call.calldata.slice(1)).toEqual(["0x1", "0x0", "0x2"]);
  });
});

// The layout test that did not exist, and whose absence shipped broken
// create_tournament calldata in 0.2.0.
//
// `buildCreateTournamentCall` hand-compiles its payload — nothing checks it
// against the contract ABI — so a struct that drifts produces felts in the
// wrong POSITIONS, which no type system sees. v2 trimmed GameConfig from six
// fields to three; the builder kept serialising paymaster + two Option::None
// tags, so the contract read the paymaster bool as the Option<EntryFeeKind>
// tag and deserialised garbage from there onward.
describe("buildCreateTournamentCall felt layout", () => {
  const call = () =>
    buildCreateTournamentCall(BUDOKAN, {
      creatorRewardsAddress: "0x1",
      name: "T",
      description: "d",
      schedule: {
        registrationStartDelay: 0,
        registrationEndDelay: 3600,
        gameStartDelay: 0,
        gameEndDelay: 3600,
        submissionDuration: 3600,
      },
      gameAddress: "0x2",
      settingsId: 0,
      soulbound: false,
      leaderboard: { ascending: false, gameMustBeOver: false },
      salt: 1,
      metadataValue: 0,
    });

  test("game_config occupies exactly four felts", () => {
    const cd = call().calldata as string[];
    // creator(1) + name(1) + description ByteArray(3) + schedule(5) = 10
    const GAME_CONFIG = 10;
    expect(cd[GAME_CONFIG]).toBe("2"); // game_address
    expect(cd[GAME_CONFIG + 1]).toBe("0"); // settings_id
    expect(cd[GAME_CONFIG + 2]).toBe("0"); // soulbound
    expect(cd[GAME_CONFIG + 3]).toBe("0"); // paymaster
    // The next felt MUST be the entry-fee Option tag (1 = None). If this reads
    // "0" the struct has grown again — client_url and renderer used to sit
    // here — and every field after it is shifted.
    expect(cd[GAME_CONFIG + 4]).toBe("1");
  });

  test("the whole payload is the length v2 expects", () => {
    // 10 (above) + game_config 4 + entry_fee None 1 + entry_requirement None 1
    // + leaderboard 2 + salt 1 + metadata_value 1
    expect((call().calldata as string[]).length).toBe(20);
  });
});
