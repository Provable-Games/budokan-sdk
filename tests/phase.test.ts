import { describe, expect, test } from "bun:test";
import { tournamentPhase } from "../src/phase/index.ts";

// Mirrors the contract test in
// packages/budokan/src/libs/schedule.cairo (created_at = 1000).
const CREATED = 1000;

describe("tournamentPhase — no registration period", () => {
  const t = {
    createdAtOnchain: CREATED,
    registrationStartDelay: 0,
    registrationEndDelay: 0,
    gameStartDelay: 100, // game starts 1100
    gameEndDelay: 100, // game ends 1200
    submissionDuration: 50, // sub ends 1250
  };
  test("staging before game start", () => expect(tournamentPhase(t, 1050)).toBe("staging"));
  test("live during game", () => expect(tournamentPhase(t, 1150)).toBe("live"));
  test("submission after game", () => expect(tournamentPhase(t, 1220)).toBe("submission"));
  test("finalized after submission", () => expect(tournamentPhase(t, 1251)).toBe("finalized"));
});

describe("tournamentPhase — with registration period", () => {
  const t = {
    createdAtOnchain: CREATED,
    registrationStartDelay: 50, // reg starts 1050
    registrationEndDelay: 30, // reg ends 1080
    gameStartDelay: 100, // game starts 1100
    gameEndDelay: 100, // game ends 1200
    submissionDuration: 50, // sub ends 1250
  };
  test("scheduled before registration", () => expect(tournamentPhase(t, 1040)).toBe("scheduled"));
  test("registration during window", () => expect(tournamentPhase(t, 1060)).toBe("registration"));
  test("staging between reg and game", () => expect(tournamentPhase(t, 1090)).toBe("staging"));
  test("live during game", () => expect(tournamentPhase(t, 1150)).toBe("live"));
  test("submission during submission window", () => expect(tournamentPhase(t, 1220)).toBe("submission"));
  test("finalized after submission", () => expect(tournamentPhase(t, 1251)).toBe("finalized"));
});

describe("tournamentPhase — exact boundaries belong to the later phase", () => {
  const t = {
    createdAtOnchain: CREATED,
    registrationStartDelay: 100, // reg starts 1100
    registrationEndDelay: 100, // reg ends 1200
    gameStartDelay: 300, // game starts 1300
    gameEndDelay: 100, // game ends 1400
    submissionDuration: 50, // sub ends 1450
  };
  test("right before reg → scheduled", () => expect(tournamentPhase(t, 1099)).toBe("scheduled"));
  test("at reg start → registration", () => expect(tournamentPhase(t, 1100)).toBe("registration"));
  test("at reg end → staging", () => expect(tournamentPhase(t, 1200)).toBe("staging"));
  test("at game start → live", () => expect(tournamentPhase(t, 1300)).toBe("live"));
  test("at game end → submission", () => expect(tournamentPhase(t, 1400)).toBe("submission"));
  test("at sub end → finalized", () => expect(tournamentPhase(t, 1450)).toBe("finalized"));
});

describe("tournamentPhase — falls back to structured schedule + null on no created_at", () => {
  test("reads schedule when top-level delays absent", () => {
    const t = {
      createdAtOnchain: CREATED,
      schedule: {
        registrationStartDelay: 0,
        registrationEndDelay: 0,
        gameStartDelay: 100,
        gameEndDelay: 100,
        submissionDuration: 50,
      },
    };
    expect(tournamentPhase(t, 1150)).toBe("live");
  });
  test("null created_at → null", () => {
    expect(tournamentPhase({ createdAtOnchain: null }, 1150)).toBeNull();
  });
});
