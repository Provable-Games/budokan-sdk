import { describe, expect, test } from "bun:test";
import { scheduleFromDurations, scheduleFromTimestamps } from "../src/schedule/index.ts";

// Contract anchoring (budokan/contracts/.../libs/schedule.cairo):
//   reg_start  = created_at + registration_start_delay
//   reg_end    = reg_start  + registration_end_delay
//   game_start = created_at + game_start_delay
//   game_end   = game_start + game_end_delay
//   sub_end    = game_end   + submission_duration
// These tests reconstruct absolute times with those formulas and assert they
// match the intent — the exact regression PR #80 review caught (end fields
// were encoded cumulatively from creation).

function absolute(s: ReturnType<typeof scheduleFromDurations>, createdAt: number) {
  const regStart = createdAt + s.registrationStartDelay;
  const regEnd = regStart + s.registrationEndDelay;
  const gameStart = createdAt + s.gameStartDelay;
  const gameEnd = gameStart + s.gameEndDelay;
  const subEnd = gameEnd + s.submissionDuration;
  return { regStart, regEnd, gameStart, gameEnd, subEnd };
}

describe("scheduleFromDurations", () => {
  test("open tournament: play only", () => {
    const s = scheduleFromDurations({ playSeconds: 3600 });
    expect(s).toEqual({
      registrationStartDelay: 0,
      registrationEndDelay: 0,
      gameStartDelay: 0,
      gameEndDelay: 3600,
      submissionDuration: 86400,
    });
  });

  test("fixed registration: end fields are durations, not cumulative offsets", () => {
    // 1h delay, 24h registration, 2h staging, 48h play — the case that
    // exposed the cumulative-encoding bug.
    const s = scheduleFromDurations({
      registrationDelaySeconds: 3600,
      registrationSeconds: 86400,
      stagingSeconds: 7200,
      playSeconds: 172800,
      submissionSeconds: 86400,
    });
    expect(s.registrationEndDelay).toBe(86400); // NOT 90000
    expect(s.gameEndDelay).toBe(172800); // NOT 270000
    const t = absolute(s, 1_000_000);
    expect(t.regStart).toBe(1_000_000 + 3600);
    expect(t.regEnd).toBe(t.regStart + 86400);
    expect(t.gameStart).toBe(t.regEnd + 7200);
    expect(t.gameEnd).toBe(t.gameStart + 172800);
    expect(t.subEnd).toBe(t.gameEnd + 86400);
    // Contract validity: reg_start_delay + reg_end_delay <= game_start_delay.
    expect(s.registrationStartDelay + s.registrationEndDelay).toBeLessThanOrEqual(s.gameStartDelay);
  });

  test("open tournament ignores a registration delay in the reg fields", () => {
    const s = scheduleFromDurations({ registrationDelaySeconds: 600, playSeconds: 3600 });
    // has_registration() must stay false: both reg delays 0.
    expect(s.registrationStartDelay).toBe(0);
    expect(s.registrationEndDelay).toBe(0);
    expect(s.gameStartDelay).toBe(600);
  });

  test("rejects zero play window and negative/fractional inputs", () => {
    expect(() => scheduleFromDurations({ playSeconds: 0 })).toThrow();
    expect(() => scheduleFromDurations({ playSeconds: -1 })).toThrow();
    expect(() => scheduleFromDurations({ playSeconds: 3600, stagingSeconds: 1.5 })).toThrow();
  });
});

describe("scheduleFromTimestamps", () => {
  const NOW = 1_800_000_000;

  test("full schedule from absolute times", () => {
    const s = scheduleFromTimestamps({
      registrationStart: NOW + 3600,
      registrationEnd: NOW + 3600 + 86400,
      gameStart: NOW + 3600 + 86400 + 7200,
      gameEnd: NOW + 3600 + 86400 + 7200 + 172800,
      submissionEnd: NOW + 3600 + 86400 + 7200 + 172800 + 86400,
      now: NOW,
    });
    expect(s).toEqual({
      registrationStartDelay: 3600,
      registrationEndDelay: 86400,
      gameStartDelay: 3600 + 86400 + 7200,
      gameEndDelay: 172800,
      submissionDuration: 86400,
    });
  });

  test("defaults: gameStart from registrationEnd, submission 24h", () => {
    const s = scheduleFromTimestamps({
      registrationStart: NOW,
      registrationEnd: NOW + 3600,
      gameEnd: NOW + 3600 + 7200,
      now: NOW,
    });
    expect(s.gameStartDelay).toBe(3600);
    expect(s.gameEndDelay).toBe(7200);
    expect(s.submissionDuration).toBe(86400);
  });

  test("open tournament: only gameEnd required", () => {
    const s = scheduleFromTimestamps({ gameEnd: NOW + 3600, now: NOW });
    expect(s).toEqual({
      registrationStartDelay: 0,
      registrationEndDelay: 0,
      gameStartDelay: 0,
      gameEndDelay: 3600,
      submissionDuration: 86400,
    });
  });

  test("past timestamps clamp to now (starts immediately)", () => {
    const s = scheduleFromTimestamps({
      registrationStart: NOW - 500,
      registrationEnd: NOW + 3600,
      gameEnd: NOW + 3600 + 7200,
      now: NOW,
    });
    expect(s.registrationStartDelay).toBe(0);
    expect(s.registrationEndDelay).toBe(3600);
  });

  test("rejects half-specified registration and bad ordering", () => {
    expect(() => scheduleFromTimestamps({ registrationStart: NOW, gameEnd: NOW + 10, now: NOW })).toThrow(
      /together/,
    );
    expect(() =>
      scheduleFromTimestamps({
        registrationStart: NOW + 100,
        registrationEnd: NOW + 50,
        gameEnd: NOW + 500,
        now: NOW,
      }),
    ).toThrow(/after registrationStart/);
    expect(() =>
      scheduleFromTimestamps({
        registrationStart: NOW,
        registrationEnd: NOW + 3600,
        gameStart: NOW + 1800, // play overlaps registration
        gameEnd: NOW + 7200,
        now: NOW,
      }),
    ).toThrow(/not be before registrationEnd/);
    expect(() => scheduleFromTimestamps({ gameEnd: NOW, now: NOW })).toThrow(/after gameStart/);
  });
});
