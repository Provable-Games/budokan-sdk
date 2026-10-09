import { describe, expect, test } from "bun:test";
import { CallData } from "starknet";
import abi from "../src/rpc/abis/budokan.json";
import {
  addRegistrant,
  advanceBracket,
  assignRegistrants,
  attachMatchTournament,
  attachRoundOneTree,
  bracketEntryCalls,
  bracketFeePrizeCalls,
  bracketRoundOneAllowlistCall,
  createBracket,
  createRegisteringBracket,
  pendingMatchCreateCalls,
  roundMatchCreateCalls,
  type BracketState,
  type CreateBracketOptions,
} from "../src/brackets/index.ts";
import { MAX_ALLOWLIST_ENTRY_COUNT } from "../src/extensions/merkle.ts";

const options = (attemptsPerPlayer?: number): CreateBracketOptions => ({
  id: "attempts",
  budokanAddress: "0x1",
  game: "0x2",
  chain: "sepolia",
  settingsId: 0,
  creatorRewardsAddress: "0x3",
  attemptsPerPlayer,
  scheduleTemplate: {
    registrationStartDelay: 0,
    registrationEndDelay: 0,
    gameStartDelay: 0,
    gameEndDelay: 3600,
    submissionDuration: 3600,
  },
  leaderboard: { ascending: false, gameMustBeOver: true },
  players: [1, 2, 3, 4].map((n) => ({ address: `0x${n}` })),
});
const inputs = abi
  .flatMap((entry) => ("items" in entry ? entry.items : []))
  .find((entry) => entry?.name === "create_tournament")!
  .inputs!.map((input) => input.type);
function requirement(call: { calldata: string[] }) {
  const decoded = new CallData(abi).decodeParameters(
    inputs,
    call.calldata,
  ) as unknown[];
  return (
    decoded[5] as {
      Some: {
        entry_limit: bigint;
        entry_requirement_type: {
          variant: { extension: { address: bigint; config: bigint[] } };
        };
      };
    }
  ).Some;
}
function attachTrees(state: BracketState) {
  state.matches
    .filter((m) => m.round === 1)
    .forEach((m, i) => attachRoundOneTree(state, m.id, 10 + i));
}
function deployRoundOne(state: BracketState) {
  attachTrees(state);
  roundMatchCreateCalls(state, 1).forEach(({ matchId }, i) =>
    attachMatchTournament(state, matchId, String(100 + i)),
  );
}

describe("bracket attempts per player", () => {
  test("new and legacy states default to one; merkle leaves and calldata agree", () => {
    for (const legacy of [false, true]) {
      const state = createBracket(options());
      expect(state.attemptsPerPlayer).toBe(1);
      if (legacy) delete state.attemptsPerPlayer;
      const tree = bracketRoundOneAllowlistCall(state, state.matches[0]!.id);
      expect(tree.entries.map((e) => e.count)).toEqual([1, 1]);
      attachTrees(state);
      expect(
        requirement(roundMatchCreateCalls(state, 1)[0]!.call).entry_limit,
      ).toBe(1n);
    }
  });
  test.each([0, -1, 1.5, NaN, Infinity, MAX_ALLOWLIST_ENTRY_COUNT + 1])(
    "rejects invalid attempt quota %s",
    (attempts) => {
      expect(() => createBracket(options(attempts))).toThrow(
        "attemptsPerPlayer",
      );
      expect(() =>
        createRegisteringBracket({ ...options(attempts), size: 4 }),
      ).toThrow("attemptsPerPlayer");
    },
  );
  test("requires enforcement and a first-round tree for multiple attempts", () => {
    expect(() => createBracket({ ...options(2), gated: false })).toThrow(
      "gated bracket",
    );
    const state = createBracket(options(2));
    expect(() => roundMatchCreateCalls(state, 1)).toThrow("allowlist");
    expect(() => pendingMatchCreateCalls(state)).toThrow("allowlist");
  });
  test("sets both immutable leaf counts and first-round limits for both creation paths", () => {
    const state = createBracket(options(2));
    const tree = bracketRoundOneAllowlistCall(state, state.matches[0]!.id);
    expect(tree.call.entrypoint).toBe("create_tree");
    expect(tree.entries.map((e) => e.count)).toEqual([2, 2]);
    expect(new Set(tree.entries.map((e) => BigInt(e.address))).size).toBe(2);
    attachTrees(state);
    for (const call of [
      ...roundMatchCreateCalls(state, 1),
      ...pendingMatchCreateCalls(state),
    ]) {
      expect(requirement(call.call).entry_limit).toBe(2n);
    }
  });
  test("registration and JSON persistence preserve the quota", () => {
    const state = createRegisteringBracket({ ...options(3), size: 4 });
    options().players.forEach((player) => addRegistrant(state, player));
    const restored = JSON.parse(JSON.stringify(state)) as BracketState;
    const assigned = assignRegistrants(restored, { seeding: "as-given" });
    expect(assigned.attemptsPerPlayer).toBe(3);
    expect(
      bracketRoundOneAllowlistCall(
        assigned,
        assigned.matches[0]!.id,
      ).entries.map((e) => e.count),
    ).toEqual([3, 3]);
  });
  test("later rounds grant attempts but still qualify only first place", () => {
    const state = createBracket(options(2));
    deployRoundOne(state);
    const req = requirement(roundMatchCreateCalls(state, 2)[0]!.call);
    expect(req.entry_limit).toBe(2n);
    expect(req.entry_requirement_type.variant.extension.config).toEqual([
      1n,
      0n,
      1n,
      100n,
      101n,
    ]);
  });
  test("selects each owner's best rank, retains the winning token, and gates incremental creation", async () => {
    const state = createBracket(options(2));
    deployRoundOne(state);
    await advanceBracket(state, async (id) => {
      const match = state.matches.find((m) => m.tournamentId === id)!;
      return {
        finished: true,
        ranking: [
          { address: match.playerA!.address, position: 4, tokenId: "904" },
          { address: match.playerB!.address, position: 2, tokenId: "902" },
          {
            address: `0x000${BigInt(match.playerA!.address).toString(16)}`,
            position: 1,
            tokenId: "901",
          },
          { address: match.playerB!.address, position: 3, tokenId: "903" },
        ],
      };
    });
    for (const m of state.matches.filter((m) => m.round === 1)) {
      expect(m.winner?.address).toBe(m.playerA!.address);
      expect(m.winnerTokenId).toBe("901");
    }
    const next = pendingMatchCreateCalls(state)[0]!;
    expect(requirement(next.call).entry_limit).toBe(2n);
    expect(
      requirement(
        next.call,
      ).entry_requirement_type.variant.extension.config.slice(0, 3),
    ).toEqual([1n, 0n, 1n]);
    attachMatchTournament(state, next.matchId, "200");
    const final = state.matches.find((m) => m.id === next.matchId)!;
    const [batch] = bracketEntryCalls(
      state,
      final.id,
      final.playerA!.address,
      undefined,
      2,
    );
    expect(batch!.entrypoint).toBe("enter_tournament_for_recipients");
    const data = batch!.calldata.map(BigInt);
    expect(data.slice(0, 2)).toEqual([200n, 2n]);
    // Both attempts qualify through the same first-place token, never the lower scoring attempt.
    expect(data.filter((value) => value === 901n)).toHaveLength(2);
    expect(data).not.toContain(904n);
    expect(
      bracketEntryCalls(state, final.id, final.playerA!.address)[0]!.entrypoint,
    ).toBe("enter_tournament");
  });
  test("round-one multi-mint repeats the player's proof inside one safe batch", () => {
    const state = createBracket(options(2));
    deployRoundOne(state);
    const match = state.matches[0]!;
    const [batch] = bracketEntryCalls(
      state,
      match.id,
      match.playerA!.address,
      ["777", "888"],
      2,
    );
    expect(batch!.entrypoint).toBe("enter_tournament_for_recipients");
    expect(batch!.calldata.map(BigInt).filter((v) => v === 777n)).toHaveLength(
      2,
    );
    for (const count of [0, -1, 1.5, 3, NaN, Infinity]) {
      expect(() =>
        bracketEntryCalls(
          state,
          match.id,
          match.playerA!.address,
          ["777"],
          count,
        ),
      ).toThrow("Requested attempts");
    }
    state.attemptsPerPlayer = 3000;
    expect(() =>
      bracketEntryCalls(state, match.id, match.playerA!.address, ["777"], 2049),
    ).toThrow("batch limit");
  });
  test("does not replace trees after deployment or invent competitors", () => {
    const state = createBracket(options(2));
    expect(() => bracketRoundOneAllowlistCall(state, "missing")).toThrow(
      "Unknown",
    );
    expect(() =>
      bracketRoundOneAllowlistCall(
        state,
        state.matches.find((m) => m.round === 2)!.id,
      ),
    ).toThrow("round-one");
    const first = state.matches[0]!;
    const original = first.playerB;
    first.playerB = undefined;
    expect(() => bracketRoundOneAllowlistCall(state, first.id)).toThrow(
      "two distinct",
    );
    first.playerB = { ...first.playerA! };
    expect(() => bracketRoundOneAllowlistCall(state, first.id)).toThrow(
      "two distinct",
    );
    first.playerB = original;
    deployRoundOne(state);
    expect(() => bracketRoundOneAllowlistCall(state, first.id)).toThrow(
      "uncreated",
    );
  });
});


test("multi-attempt fee escrow rejects runner-up and elimination tiers before building calls", () => {
  const state = createBracket(options(2));
  for (const [i, match] of state.matches.entries()) attachMatchTournament(state, match.id, String(100 + i));
  const split = { tokenAddress: "0xf", fee: "1000", tiersBps: [7000, 3000] };
  expect(() => bracketFeePrizeCalls(state, split)).toThrow("winner-take-all");
  expect(() => bracketFeePrizeCalls(state, { ...split, tiersBps: [9000, 0, 1000] })).toThrow("winner-take-all");
  expect(bracketFeePrizeCalls(state, { ...split, tiersBps: [10000] })).toHaveLength(2);
  state.attemptsPerPlayer = 1;
  expect(bracketFeePrizeCalls(state, split).length).toBeGreaterThan(2);
});
