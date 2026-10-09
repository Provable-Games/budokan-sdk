import { buildCreateBracketWithAllowlistCall, buildBeginRegistrationAllowlistCall, buildImportRegistrationAllowlistCall, buildFinalizeRegistrationAllowlistCall, decodeRegistrationAllowlistProgress, decodeBracketAssignmentProgress } from "../src/onchain-brackets/index.js";
import { buildCreateFreeRosterCall, buildImportFreeRosterCall, buildBracketStartRecoveryCall, buildBracketRecoverEntryPoolCall, buildBracketRefundEntryPoolCall } from "../src/onchain-brackets/index.js";
import { describe, expect, test } from "bun:test";
import { CallData } from "starknet";
import abi from "../src/rpc/abis/bracket.json";
import { buildCreateBracketCall, buildBracketSeedCalls, buildBracketCloseCall, buildBracketCommitCall, buildBracketAssignmentCall, buildBracketMatchesCall, type CreateBracketConfig } from "../src/onchain-brackets/index.ts";
const config: CreateBracketConfig = {
  game: "0x123", size: 4, settingsId: 0, entryFee: 0n, feeToken: "0x0",
  registrationDeadline: 2000000000, gameDuration: 3600, submissionDuration: 3600,
  leaderboardAscending: false, gameMustBeOver: true,
};
function decode(call: ReturnType<typeof buildCreateBracketCall>): any[] {
  const method = abi.flatMap(e => "items" in e ? e.items : []).find(e => e?.name === call.entrypoint)!;
  return new CallData(abi).decodeParameters(method.inputs!.map(i => i.type), call.calldata as string[]) as any[];
}
describe("on-chain bracket builder", () => {
  test("default and explicit one preserve the deployed legacy ABI", () => {
    const original = buildCreateBracketCall("0xabc", config);
    expect(original.entrypoint).toBe("create_bracket");
    expect(buildCreateBracketCall("0xabc", { ...config, attemptsPerPlayer: 1 })).toEqual(original);
    expect(decode(original)[0].size).toBe(4n);
    expect(decode(original)[0].status).toBe(0n);
  });
  test("multiple attempts decode against the compiled Cairo ABI", () => {
    const call = buildCreateBracketCall("0xabc", { ...config, attemptsPerPlayer: 3 });
    expect(call.entrypoint).toBe("create_bracket_with_attempts");
    const [stored, tiers, attempts] = decode(call);
    expect(stored.game).toBe(0x123n);
    expect(stored.game_duration).toBe(3600n);
    expect(tiers).toEqual([]);
    expect(attempts).toBe(3n);
  });
  test.each([0, -1, NaN, Infinity, 2.5, 2147483648])("rejects invalid quota %s", attemptsPerPlayer => {
    expect(() => buildCreateBracketCall("0xabc", { ...config, attemptsPerPlayer })).toThrow("attemptsPerPlayer");
  });
  test("prevents game-token prize splits from paying the same multi-attempt player twice", () => {
    expect(() => buildCreateBracketCall("0xabc", { ...config, attemptsPerPlayer: 2 }, [7000, 3000])).toThrow("winner-take-all");
    expect(decode(buildCreateBracketCall("0xabc", config, [7000, 3000]))[1]).toEqual([7000n, 3000n]);
  });
  test("VRF request and consumption share the bracket address and salt", () => {
    const calls = buildBracketSeedCalls("0xabc", "0xdef", 42n);
    expect(calls.map(c => c.entrypoint)).toEqual(["request_random", "close_registration", "fulfill_assignment"]);
    expect(calls[0]!.calldata).toEqual(["0xabc", "1", "42"]);
    expect(calls[2]!.contractAddress).toBe("0xabc");
    expect(buildBracketSeedCalls("0xabc", "0xdef", 42n, false)).toEqual([calls[0], calls[2]]);
  });
  test("bounded resumable match creation", () => {
    expect(buildBracketMatchesCall("0xabc", 42, 2).calldata).toEqual(["42", "2"]);
    expect(() => buildBracketMatchesCall("0xabc", 42, 0)).toThrow("maxMatches");
  });
});

test("1024-player setup window preserves the attempts and configuration ABI", () => {
  const call = buildCreateBracketCall("0xabc", { ...config, size: 1024, setupWindow: 3600, attemptsPerPlayer: 2 });
  expect(call.entrypoint).toBe("create_bracket_with_setup");
  const [stored, tiers, attempts, setup] = decode(call);
  expect(stored.size).toBe(1024n); expect(tiers).toEqual([]);
  expect(attempts).toBe(2n); expect(setup).toBe(3600n);
});
test.each([1, 3, 16384, -1, 2.5])("rejects unsupported field %s", size => {
  expect(() => buildCreateBracketCall("0xabc", { ...config, size })).toThrow("size");
});
test.each([0, 59, 86401, NaN, 60.5])("rejects invalid setup window %s", setupWindow => {
  expect(() => buildCreateBracketCall("0xabc", { ...config, setupWindow })).toThrow("setupWindow");
});

test("separates block-hash commitment and assignment into raw-account calls", () => {
  expect(buildBracketCloseCall("0xabc", 42n)).toEqual({ contractAddress: "0xabc", entrypoint: "close_registration", calldata: ["42"] });
  expect(buildBracketAssignmentCall("0xabc", 42n)).toEqual({ contractAddress: "0xabc", entrypoint: "fulfill_assignment", calldata: ["42"] });
});

test("buffered default attempts and upgrade commitment decode against the Cairo ABI", () => {
  const creation = buildCreateBracketCall("0xabc", { ...config, setupWindow: 3600 });
  expect(creation.entrypoint).toBe("create_bracket_with_setup");
  const [, , attempts, setup] = decode(creation);
  expect(attempts).toBe(1n); expect(setup).toBe(3600n);
  const commit = buildBracketCommitCall("0xabc", 42n);
  expect(commit.entrypoint).toBe("commit_assignment");
  expect(new CallData(abi).decodeParameters(["core::integer::u64"], commit.calldata as string[])).toBe(42n);
});

test.each([true, false])("serializes explicit full-field policy %s atomically", requireFull => {
  const call = buildCreateBracketCall("0xabc", {...config, requireFull, attemptsPerPlayer: 5});
  expect(call.entrypoint).toBe("create_bracket_with_requirements");
  const [stored, tiers, attempts, setup, full] = decode(call);
  expect(stored.size).toBe(4n); expect(tiers).toEqual([]);
  expect(attempts).toBe(5n); expect(setup).toBe(3600n); expect(full).toBe(requireFull);
});
test("rejects a full-field requirement without a fixed field", () => {
  expect(() => buildCreateBracketCall("0xabc", {...config, size: 0, requireFull: true})).toThrow("fixed size");
  expect(() => buildCreateBracketCall("0xabc", {...config, requireFull: 1 as unknown as boolean})).toThrow("boolean");
});

describe("entry-funded final prize recovery", () => {
  test("builds recovery for saved and legacy prize IDs", () => {
    expect(buildBracketRecoverEntryPoolCall("0xabc", 2n).calldata).toEqual(["2", "0"]);
    expect(buildBracketRecoverEntryPoolCall("0xabc", 2n, 99n).calldata).toEqual(["2", "99"]);
    expect(decode(buildBracketRecoverEntryPoolCall("0xabc", 2n, 99n))).toEqual([2n, 99n]);
    expect(() => buildBracketRecoverEntryPoolCall("0xabc", 2n, -1n)).toThrow();
    expect(() => buildBracketRecoverEntryPoolCall("0xabc", 2n, 1n << 64n)).toThrow();
  });
  test("binds both refund indices and rejects out-of-range proofs", () => {
    expect(buildBracketRefundEntryPoolCall("0xabc", 2n, 3, 1)).toEqual({contractAddress:"0xabc", entrypoint:"refund_entry_pool", calldata:["2", "3", "1"]});
    expect(decode(buildBracketRefundEntryPoolCall("0xabc", 2n, 3, 1))).toEqual([2n, 3n, 1n]);
    for (const index of [-1, 8192, 0.5, NaN]) {
      expect(() => buildBracketRefundEntryPoolCall("0xabc", 2n, index, 0)).toThrow();
      expect(() => buildBracketRefundEntryPoolCall("0xabc", 2n, 0, index)).toThrow();
    }
  });
});


test("free fixed roster creation decodes against the compiled ABI", () => {
  const call = buildCreateFreeRosterCall("0xabc", {...config, size: 1024, settingsId: 3, attemptsPerPlayer: 5});
  const [stored, attempts, setup] = decode(call);
  expect(call.entrypoint).toBe("create_free_roster");
  expect(stored.size).toBe(1024n);
  expect(stored.entry_fee).toBe(0n);
  expect(stored.settings_id).toBe(3n);
  expect(attempts).toBe(5n);
  expect(setup).toBe(3600n);
});
test("fixed rosters reject paid, flexible and invalid capacity modes", () => {
  expect(() => buildCreateFreeRosterCall("0xabc", {...config, entryFee: 1n})).toThrow("free");
  expect(() => buildCreateFreeRosterCall("0xabc", {...config, requireFull: false})).toThrow("full");
  expect(() => buildCreateFreeRosterCall("0xabc", {...config, size: 0})).toThrow();
});
test("roster import retains explicit cursor and address order", () => {
  const call = buildImportFreeRosterCall("0xabc", 42n, 256, ["0x111", "0x222"]);
  const [id, cursor, players] = decode(call);
  expect([id, cursor, players]).toEqual([42n, 256n, [273n, 546n]]);
  expect(buildBracketStartRecoveryCall("0xabc", 42n)).toEqual({contractAddress: "0xabc", entrypoint: "build_matches", calldata: ["42", "0"]});
});
test("roster import rejects empty/oversized/duplicate/zero batches and invalid cursor", () => {
  expect(() => buildImportFreeRosterCall("0xabc", 1n, 0, [])).toThrow("batch");
  expect(() => buildImportFreeRosterCall("0xabc", 1n, 0, Array(257).fill("0x1"))).toThrow("batch");
  expect(() => buildImportFreeRosterCall("0xabc", 1n, 0, ["0x1", "0x01"])).toThrow("Duplicate");
  expect(() => buildImportFreeRosterCall("0xabc", 1n, 0, ["0x0"])).toThrow("address");
  expect(() => buildImportFreeRosterCall("0xabc", 1n, -1, ["0x1"])).toThrow("cursor");
  expect(() => buildImportFreeRosterCall("0xabc", 1n, 8192, ["0x1"])).toThrow("batch");
});


describe("large fields and invitation uploads", () => {
  test.each([2048, 4096, 8192])("compiled ABI preserves fixed field %s", size => {
    expect(decode(buildCreateBracketCall("0xabc", {...config, size}))[0].size).toBe(BigInt(size));
    expect(decode(buildCreateFreeRosterCall("0xabc", {...config, size}))[0].size).toBe(BigInt(size));
  });
  test("creation locks the invitation list with full-field and attempt policy in one call", () => {
    const call = buildCreateBracketWithAllowlistCall("0xabc", {...config, size: 8192, attemptsPerPlayer: 5}, 8192);
    const [stored, tiers, attempts, setup, full, expected] = decode(call);
    expect(call.entrypoint).toBe("create_bracket_with_allowlist");
    expect(stored.size).toBe(8192n); expect(tiers).toEqual([]);
    expect([attempts, setup, full, expected]).toEqual([5n, 3600n, true, 8192n]);
  });
  test("ordered allowlist imports preserve the final batch and use the compiled ABI", () => {
    const call = buildImportRegistrationAllowlistCall("0xabc", 2n, 7936, Array.from({length: 256}, (_, i) => `0x${(i+1).toString(16)}`));
    expect(decode(call).slice(0, 2)).toEqual([2n, 7936n]);
    expect(decode(call)[2]).toHaveLength(256);
    expect(decode(buildBeginRegistrationAllowlistCall("0xabc", 2n, 8192))).toEqual([2n, 8192n]);
    expect(buildFinalizeRegistrationAllowlistCall("0xabc", 2n).calldata).toEqual(["2"]);
  });
  test("rejects incomplete full-field invitations, invalid counts and oversized imports", () => {
    expect(() => buildCreateBracketWithAllowlistCall("0xabc", config, 2)).toThrow("fill");
    for(const count of [0, 1, 8193, 1.5]) expect(() => buildBeginRegistrationAllowlistCall("0xabc", 1n, count)).toThrow("allowlistCount");
    expect(() => buildImportRegistrationAllowlistCall("0xabc", 1n, 8192, ["0x1"])).toThrow("batch");
  });
  test("decodes loading, finalized and legacy progress without relaxing malformed responses", () => {
    expect(decodeRegistrationAllowlistProgress(["256", "8192", "0"])).toEqual({imported:256,expected:8192,ready:false});
    expect(decodeRegistrationAllowlistProgress(["0", "0", "1"])).toEqual({imported:0,expected:0,ready:true});
    expect(() => decodeRegistrationAllowlistProgress(["256", "8192", "1"])).toThrow("Invalid");
    expect(decodeBracketAssignmentProgress(["256", "8192"])).toEqual({completed:256,total:8192});
    expect(decodeBracketAssignmentProgress(["0", "3"])).toEqual({completed:0,total:3});
    expect(() => decodeBracketAssignmentProgress(["8193", "8192"])).toThrow("Invalid");
  });
});
