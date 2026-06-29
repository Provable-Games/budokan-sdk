import { describe, expect, test } from "bun:test";
import {
  advanceBracket,
  attachMatchTournament,
  bracketEntryCalls,
  bracketFeeders,
  bracketFinalPrizeCalls,
  bracketFeePrizeCalls,
  bracketRounds,
  createBracket,
  decodeTournamentValidatorConfig,
  nextMatchesFor,
  pendingMatchCreateCalls,
  reconstructBrackets,
  roundMatchCreateCalls,
  type CreateBracketOptions,
  type MatchReader,
} from "../src/brackets/index.ts";

const baseOpts = (
  players: Array<{ address: string; name?: string }>,
): CreateBracketOptions => ({
  id: "b1",
  budokanAddress: "0xbudokan",
  game: "0xgame",
  chain: "sepolia",
  settingsId: 0,
  creatorRewardsAddress: "0xcreator",
  scheduleTemplate: {
    registrationStartDelay: 0,
    registrationEndDelay: 600,
    gameStartDelay: 0,
    gameEndDelay: 600,
    submissionDuration: 600,
  },
  leaderboard: { ascending: false, gameMustBeOver: false },
  players,
});

const players = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ address: `0x${i + 1}`, name: `P${i + 1}` }));

describe("createBracket sizing & seeding", () => {
  test("rejects fewer than 2 players", () => {
    expect(() => createBracket(baseOpts(players(1)))).toThrow();
  });

  test("power-of-two: 4 players → size 4, 3 round-1+2 matches, no byes", () => {
    const s = createBracket(baseOpts(players(4)));
    expect(s.size).toBe(4);
    expect(s.matches).toHaveLength(3); // 2 + 1
    const r1 = s.matches.filter((m) => m.round === 1);
    expect(r1).toHaveLength(2);
    expect(r1.every((m) => m.status === "pending")).toBe(true);
    // Standard seeding: top seed faces the lowest seed.
    const top = r1.find((m) => m.playerA?.seed === 1)!;
    expect(top.playerB?.seed).toBe(4);
  });

  test("non-power-of-two: 3 players → size 4, one bye for seed 1", () => {
    // Byes are only allowed for ungated brackets.
    const s = createBracket({ ...baseOpts(players(3)), gated: false });
    expect(s.size).toBe(4);
    const r1 = s.matches.filter((m) => m.round === 1);
    const bye = r1.find((m) => m.status === "bye")!;
    expect(bye.winner?.seed).toBe(1); // top seed gets the bye
    // The final should already have seed 1 in one slot via propagation.
    const final = s.matches.find((m) => !m.feedsInto)!;
    expect(
      final.playerA?.seed === 1 || final.playerB?.seed === 1,
    ).toBe(true);
  });
});

describe("match creation & entry calls", () => {
  test("pendingMatchCreateCalls yields one per ready match", () => {
    const s = createBracket(baseOpts(players(4)));
    const calls = pendingMatchCreateCalls(s);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.call.entrypoint).toBe("create_tournament");
  });

  test("attach → live → entry calls work, and reject non-competitors", () => {
    const s = createBracket(baseOpts(players(4)));
    const r1 = s.matches.filter((m) => m.round === 1);
    attachMatchTournament(s, r1[0]!.id, "100");
    expect(s.matches.find((m) => m.id === r1[0]!.id)!.status).toBe("live");

    const aAddr = r1[0]!.playerA!.address;
    const calls = bracketEntryCalls(s, r1[0]!.id, aAddr);
    expect(calls[0]!.entrypoint).toBe("enter_tournament");

    expect(() => bracketEntryCalls(s, r1[0]!.id, "0xnobody")).toThrow();
  });

  test("entry before tournament attached throws", () => {
    const s = createBracket(baseOpts(players(4)));
    const r1 = s.matches.filter((m) => m.round === 1)[0]!;
    expect(() => bracketEntryCalls(s, r1.id, r1.playerA!.address)).toThrow();
  });
});

describe("advanceBracket end-to-end (4 players)", () => {
  test("resolves winners and crowns a champion", async () => {
    let s = createBracket(baseOpts(players(4)));

    // Create + attach round 1.
    for (const { matchId } of pendingMatchCreateCalls(s)) {
      attachMatchTournament(s, matchId, `t-${matchId}`);
    }

    // Reader: lower-seeded address (higher number) loses; seed-1 / seed-2 win.
    const winners = new Set(["0x1", "0x2"]); // seeds 1 and 2 advance
    const read: MatchReader = async (tid) => {
      const m = s.matches.find((x) => x.tournamentId === tid)!;
      const a = m.playerA!.address;
      const b = m.playerB!.address;
      const aWins = winners.has(a) || (!winners.has(b) && m.playerA!.seed < m.playerB!.seed);
      return {
        finished: true,
        ranking: aWins
          ? [{ address: a, position: 1 }, { address: b, position: 2 }]
          : [{ address: b, position: 1 }, { address: a, position: 2 }],
      };
    };

    // Advance round 1 → final becomes ready.
    let res = await advanceBracket(s, read);
    s = res.state;
    expect(s.status).toBe("running");
    expect(res.createCalls).toHaveLength(1); // the final

    // Attach + advance the final.
    attachMatchTournament(s, res.createCalls[0]!.matchId, "t-final");
    res = await advanceBracket(s, read);
    s = res.state;
    expect(s.status).toBe("complete");
    expect(s.champion?.seed).toBe(1);
  });

  test("does not advance while matches are unfinished", async () => {
    const s = createBracket(baseOpts(players(4)));
    for (const { matchId } of pendingMatchCreateCalls(s)) {
      attachMatchTournament(s, matchId, `t-${matchId}`);
    }
    const read: MatchReader = async () => ({ finished: false, ranking: [] });
    const res = await advanceBracket(s, read);
    expect(res.state.status).toBe("running");
    expect(res.createCalls).toHaveLength(0);
    expect(res.state.matches.every((m) => m.status !== "resolved")).toBe(true);
  });

  test("no-show: higher seed advances on empty ranking", async () => {
    const s = createBracket(baseOpts(players(4)));
    for (const { matchId } of pendingMatchCreateCalls(s)) {
      attachMatchTournament(s, matchId, `t-${matchId}`);
    }
    const read: MatchReader = async () => ({ finished: true, ranking: [] });
    const res = await advanceBracket(s, read);
    const r1 = res.state.matches.filter((m) => m.round === 1);
    for (const m of r1) {
      expect(m.status).toBe("walkover");
      // higher seed = lower number
      expect(m.winner!.seed).toBe(Math.min(m.playerA!.seed, m.playerB!.seed));
    }
  });
});

describe("nextMatchesFor", () => {
  test("returns the live/pending match for a competitor", () => {
    const s = createBracket(baseOpts(players(4)));
    const seed1 = s.players.find((p) => p.seed === 1)!;
    const next = nextMatchesFor(s, seed1.address);
    expect(next).toHaveLength(1);
    expect(next[0]!.round).toBe(1);
  });
});

describe("gated upfront deploy", () => {
  test("gated default rejects non-power-of-two rosters", () => {
    expect(() => createBracket(baseOpts(players(3)))).toThrow();
  });

  test("bracketFeeders returns the two round-1 matches feeding the final", () => {
    const s = createBracket(baseOpts(players(4)));
    const final = s.matches.find((m) => !m.feedsInto)!;
    const feeders = bracketFeeders(s, final.id);
    expect(feeders).toHaveLength(2);
    expect(feeders.every((f) => f.round === 1)).toBe(true);
    expect(feeders.map((f) => f.indexInRound)).toEqual([0, 1]);
  });

  test("round 1 create calls are ungated; round 2 gates on feeders + staggers schedule", () => {
    const s = createBracket(baseOpts(players(4)));

    // Round 1: base schedule, no gating. (Tournament ids are numeric on-chain.)
    const r1 = roundMatchCreateCalls(s, 1);
    expect(r1).toHaveLength(2);
    r1.forEach(({ matchId, call }, i) => {
      expect(call.entrypoint).toBe("create_tournament");
      attachMatchTournament(s, matchId, String(100 + i));
    });
    const r1Len = (r1[0]!.call.calldata as string[]).length;

    // Round 2 (the final): gated on its two feeders → more calldata than an
    // ungated round-1 create.
    const r2 = roundMatchCreateCalls(s, 2);
    expect(r2).toHaveLength(1);
    expect((r2[0]!.call.calldata as string[]).length).toBeGreaterThan(r1Len);
  });

  test("round 2 create throws if round 1 not deployed yet", () => {
    const s = createBracket(baseOpts(players(4)));
    expect(() => roundMatchCreateCalls(s, 2)).toThrow();
  });

  test("qualified entry attaches a QualificationProof for gated round-2 winners", async () => {
    let s = createBracket(baseOpts(players(4)));
    roundMatchCreateCalls(s, 1).forEach(({ matchId }, i) =>
      attachMatchTournament(s, matchId, String(100 + i)),
    );
    // Resolve round 1 with numeric winning token ids.
    const read: MatchReader = async (tid) => {
      const m = s.matches.find((x) => x.tournamentId === tid)!;
      return {
        finished: true,
        ranking: [
          { address: m.playerA!.address, position: 1, tokenId: String(900 + m.indexInRound) },
          { address: m.playerB!.address, position: 2, tokenId: String(800 + m.indexInRound) },
        ],
      };
    };
    s = (await advanceBracket(s, read)).state;

    const final = s.matches.find((m) => !m.feedsInto)!;
    attachMatchTournament(s, final.id, "200");
    const winnerAddr = final.playerA!.address;

    const gatedCall = bracketEntryCalls(s, final.id, winnerAddr)[0]!;
    expect(gatedCall.entrypoint).toBe("enter_tournament");
    // A gated entry carries the QualificationProof, so its calldata is longer
    // than the same entry without gating.
    const ungatedCall = bracketEntryCalls({ ...s, gated: false }, final.id, winnerAddr)[0]!;
    expect((gatedCall.calldata as string[]).length).toBeGreaterThan(
      (ungatedCall.calldata as string[]).length,
    );

    const feeder = bracketFeeders(s, final.id).find((f) => f.winner?.address === winnerAddr)!;
    expect(feeder.winnerTokenId).toBe(String(900 + feeder.indexInRound));
  });

  test("fee prize calls escrow one player's fee across placement tiers", () => {
    const s = createBracket(baseOpts(players(4))); // rounds = 2: semis + final
    // Deploy both rounds so the prize slots exist.
    for (const r of [1, 2]) {
      roundMatchCreateCalls(s, r).forEach(({ matchId }, i) =>
        attachMatchTournament(s, matchId, String(100 + r * 10 + i)),
      );
    }
    // 1000 fee, split 50% champion / 30% runner-up / 20% semifinalists.
    const calls = bracketFeePrizeCalls(s, {
      tokenAddress: "0xfee",
      fee: "1000",
      tiersBps: [5000, 3000, 2000],
    });
    // approve + add_prize(final pos1) + add_prize(final pos2) + add_prize(each of 2 semis pos2)
    expect(calls[0]!.entrypoint).toBe("approve");
    const addPrizes = calls.filter((c) => c.entrypoint === "add_prize");
    expect(addPrizes).toHaveLength(4); // final 1st, final 2nd, 2× semifinal losers
  });

  test("fee prize calls skip tiers deeper than the bracket and empty when no fee", () => {
    const s = createBracket(baseOpts(players(4)));
    for (const r of [1, 2]) {
      roundMatchCreateCalls(s, r).forEach(({ matchId }, i) =>
        attachMatchTournament(s, matchId, String(200 + r * 10 + i)),
      );
    }
    // tier index 3 (quarterfinalists) doesn't exist in a 2-round bracket → ignored.
    const calls = bracketFeePrizeCalls(s, { tokenAddress: "0xfee", fee: "1000", tiersBps: [10000, 0, 0, 5000] });
    expect(calls.filter((c) => c.entrypoint === "add_prize")).toHaveLength(1); // champion only
    expect(bracketFeePrizeCalls(s, { tokenAddress: "0xfee", fee: "0", tiersBps: [10000] })).toEqual([]);
  });

  test("final prize calls = approve + add_prize once the final is created", () => {
    let s = createBracket({
      ...baseOpts(players(4)),
      finalPrize: { tokenAddress: "0xprize", amount: "1000" },
    });
    expect(bracketFinalPrizeCalls(s)).toHaveLength(0); // final not created yet
    const final = s.matches.find((m) => !m.feedsInto)!;
    attachMatchTournament(s, final.id, "t-final");
    const calls = bracketFinalPrizeCalls(s);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.entrypoint).toBe("approve");
    expect(calls[1]!.entrypoint).toBe("add_prize");
    expect(bracketRounds(s)).toBe(2);
  });

  test("decodeTournamentValidatorConfig parses the on-chain hex config", () => {
    // [qualifierType=1, qualifyingMode=0, topPositions=1, feeders 5,6]
    expect(decodeTournamentValidatorConfig(["0x1", "0x0", "0x1", "0x5", "0x6"])).toEqual({
      qualifierType: 1,
      qualifyingMode: 0,
      topPositions: 1,
      feederTournamentIds: ["5", "6"],
    });
    expect(decodeTournamentValidatorConfig(["0x1", "0x0"])).toBeNull();
    expect(decodeTournamentValidatorConfig(undefined)).toBeNull();
  });

  test("reconstructBrackets rebuilds a 4-player bracket from gating alone", () => {
    // Tournaments 5,6 = round-1 semis (ungated); 7 = final, gated on winning 5 or 6.
    const gate = (feeders: string[]) => ({ address: "0xval", config: ["0x1", "0x0", "0x1", ...feeders.map((f) => `0x${Number(f).toString(16)}`)] });
    const tourneys = [
      { id: "7", er: gate(["5", "6"]) },
      { id: "5", er: null },
      { id: "6", er: null },
      { id: "99", er: null }, // standalone (never a feeder, no gate)
    ];
    const { brackets, standalone } = reconstructBrackets(tourneys, {
      getId: (t) => t.id,
      getEntryRequirement: (t) => t.er,
    });
    expect(standalone.map((t) => t.id)).toEqual(["99"]);
    expect(brackets).toHaveLength(1);
    const b = brackets[0]!;
    expect(b.bracketId).toBe("7");
    expect(b.rounds).toBe(2);
    expect(b.size).toBe(4);
    expect(b.final?.id).toBe("7");
    // round 1 = the two semis (5,6), round 2 = the final (7)
    expect(b.matches.map((m) => [m.tournamentId, m.round, m.isFinal])).toEqual([
      ["5", 1, false],
      ["6", 1, false],
      ["7", 2, true],
    ]);
  });

  test("reconstructBrackets respects validatorAddress and ignores non-brackets", () => {
    const tourneys = [
      { id: "7", er: { address: "0xother", config: ["0x1", "0x0", "0x1", "0x5", "0x6"] } },
      { id: "5", er: null },
      { id: "6", er: null },
    ];
    const { brackets, standalone } = reconstructBrackets(tourneys, {
      getId: (t) => t.id,
      getEntryRequirement: (t) => t.er,
      validatorAddress: "0xval", // 0xother doesn't match → no bracket edges
    });
    expect(brackets).toHaveLength(0);
    expect(standalone.map((t) => t.id).sort()).toEqual(["5", "6", "7"]);
  });
});
