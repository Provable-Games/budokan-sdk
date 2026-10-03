import { describe, expect, test } from "bun:test";
import { CallData } from "starknet";
import abi from "../src/rpc/abis/bracket.json";
import { buildCreateBracketCall, buildBracketSeedCalls, buildBracketMatchesCall, type CreateBracketConfig } from "../src/onchain-brackets/index.ts";
const config: CreateBracketConfig = {
  game: "0x123", size: 4, settingsId: 0, entryFee: 0n, feeToken: "0x0",
  registrationDeadline: 2000000000, gameDuration: 3600, submissionDuration: 3600,
  leaderboardAscending: false, gameMustBeOver: true,
};
function decode(call: ReturnType<typeof buildCreateBracketCall>): any[] {
  const method = abi.flatMap(e => "items" in e ? e.items : []).find(e => e?.name === call.entrypoint)!;
  return new CallData(abi).decodeParameters(method.inputs!.map(i => i.type), call.calldata as string[]) as any[];
}
describe("on-chain VRF bracket builder", () => {
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
    expect(calls.map(c => c.entrypoint)).toEqual(["close_registration", "request_random", "fulfill_assignment"]);
    expect(calls[1]!.calldata).toEqual(["0xabc", "1", "42"]);
    expect(calls[2]!.contractAddress).toBe("0xabc");
    expect(buildBracketSeedCalls("0xabc", "0xdef", 42n, false)).toEqual(calls.slice(1));
  });
  test("bounded resumable match creation", () => {
    expect(buildBracketMatchesCall("0xabc", 42, 2).calldata).toEqual(["42", "2"]);
    expect(() => buildBracketMatchesCall("0xabc", 42, 0)).toThrow("maxMatches");
  });
});
