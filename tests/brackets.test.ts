import { describe, expect, test } from "bun:test";
import {
  advanceBracket,
  attachMatchTournament,
  bracketEntryCalls,
  createBracket,
  nextMatchesFor,
  pendingMatchCreateCalls,
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
    const s = createBracket(baseOpts(players(3)));
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
