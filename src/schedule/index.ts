/**
 * Schedule builders for `create_tournament`.
 *
 * The on-chain `Schedule` struct is five u32 delays with MIXED anchors, which
 * integrators regularly get wrong (both this repo's Telegram bot and the MCP
 * server shipped the same bug before these helpers existed). The contract
 * (budokan/contracts/.../libs/schedule.cairo) computes:
 *
 *   reg_start  = created_at + registration_start_delay   // anchored at creation
 *   reg_end    = reg_start  + registration_end_delay     // DURATION of registration
 *   game_start = created_at + game_start_delay           // anchored at creation
 *   game_end   = game_start + game_end_delay             // DURATION of play
 *   sub_end    = game_end   + submission_duration        // DURATION of submission
 *
 * i.e. the two *start* delays are offsets from tournament creation, while the
 * *end* fields are durations of their own window. `game_start_delay` must
 * therefore already include the registration window and any staging gap
 * (the contract asserts reg_start_delay + reg_end_delay <= game_start_delay).
 *
 * Never hand-assemble these five fields — build them from either:
 *   - absolute unix timestamps: `scheduleFromTimestamps({...})`
 *   - friendly durations:       `scheduleFromDurations({...})`
 */

/** The five delay fields `create_tournament` takes (all seconds, u32). */
export interface TournamentSchedule {
  registrationStartDelay: number;
  registrationEndDelay: number;
  gameStartDelay: number;
  gameEndDelay: number;
  submissionDuration: number;
}

const DEFAULT_SUBMISSION_SECONDS = 86400;

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer (seconds), got ${value}`);
  }
}

export interface ScheduleDurations {
  /** Seconds from creation until registration opens (default 0 = immediately). */
  registrationDelaySeconds?: number;
  /**
   * Length of the registration window. 0 / omitted = "open" tournament:
   * no registration phase, players can join throughout play.
   */
  registrationSeconds?: number;
  /** Gap between registration closing and play starting (default 0). */
  stagingSeconds?: number;
  /** Length of the play window. Required. */
  playSeconds: number;
  /** Score-submission window after play ends (default 86400 = 24h). */
  submissionSeconds?: number;
}

/**
 * Build a `TournamentSchedule` from durations. This is the encoding-safe way
 * to express "1h until registration, 24h registration, 2h staging, 48h play":
 * the helper places each duration on the anchor the contract expects.
 */
export function scheduleFromDurations(spec: ScheduleDurations): TournamentSchedule {
  const regDelay = spec.registrationDelaySeconds ?? 0;
  const regWindow = spec.registrationSeconds ?? 0;
  const staging = spec.stagingSeconds ?? 0;
  const submission = spec.submissionSeconds ?? DEFAULT_SUBMISSION_SECONDS;
  assertNonNegativeInt(regDelay, "registrationDelaySeconds");
  assertNonNegativeInt(regWindow, "registrationSeconds");
  assertNonNegativeInt(staging, "stagingSeconds");
  assertNonNegativeInt(spec.playSeconds, "playSeconds");
  assertNonNegativeInt(submission, "submissionSeconds");
  if (spec.playSeconds === 0) {
    throw new Error("playSeconds must be > 0");
  }
  return {
    // A delay before an open tournament's (non-existent) registration phase
    // would only push game start; keep it out of the registration fields so
    // `has_registration()` stays false on chain.
    registrationStartDelay: regWindow > 0 ? regDelay : 0,
    registrationEndDelay: regWindow,
    gameStartDelay: regDelay + regWindow + staging,
    gameEndDelay: spec.playSeconds,
    submissionDuration: submission,
  };
}

export interface ScheduleTimestamps {
  /**
   * When registration opens (unix seconds). Provide together with
   * `registrationEnd`, or omit both for an open tournament.
   */
  registrationStart?: number;
  /** When registration closes (unix seconds). */
  registrationEnd?: number;
  /**
   * When play starts (unix seconds). Defaults to `registrationEnd` (or to
   * `now` for open tournaments).
   */
  gameStart?: number;
  /** When play ends (unix seconds). Required. */
  gameEnd: number;
  /** When score submission closes (unix seconds). Default: gameEnd + 24h. */
  submissionEnd?: number;
  /**
   * Reference time the delays are computed against (unix seconds). Defaults
   * to the current wall clock. The contract anchors delays at the block
   * timestamp when the transaction lands, so absolute times are accurate to
   * within transaction-inclusion latency; timestamps already in the past
   * clamp to "starts immediately".
   */
  now?: number;
}

/**
 * Build a `TournamentSchedule` from absolute unix timestamps — say when things
 * should happen and the helper derives the correctly-anchored delays.
 */
export function scheduleFromTimestamps(spec: ScheduleTimestamps): TournamentSchedule {
  const now = spec.now ?? Math.floor(Date.now() / 1000);
  assertNonNegativeInt(now, "now");

  if ((spec.registrationStart === undefined) !== (spec.registrationEnd === undefined)) {
    throw new Error(
      "Provide registrationStart and registrationEnd together, or neither (open tournament)",
    );
  }
  const hasRegistration = spec.registrationStart !== undefined;

  // Clamp past timestamps to `now` — "starts immediately" — rather than
  // producing negative delays that would underflow the u32 encoding.
  const at = (ts: number, label: string): number => {
    assertNonNegativeInt(ts, label);
    return Math.max(ts, now);
  };

  const regStart = hasRegistration ? at(spec.registrationStart!, "registrationStart") : now;
  const regEnd = hasRegistration ? at(spec.registrationEnd!, "registrationEnd") : now;
  const gameStart = at(spec.gameStart ?? (hasRegistration ? regEnd : now), "gameStart");
  const gameEnd = at(spec.gameEnd, "gameEnd");
  const submissionEnd = at(
    spec.submissionEnd ?? gameEnd + DEFAULT_SUBMISSION_SECONDS,
    "submissionEnd",
  );

  if (hasRegistration && regEnd <= regStart) {
    throw new Error("registrationEnd must be after registrationStart");
  }
  if (hasRegistration && gameStart < regEnd) {
    throw new Error("gameStart must not be before registrationEnd (the contract rejects overlap)");
  }
  if (gameEnd <= gameStart) {
    throw new Error("gameEnd must be after gameStart");
  }
  if (submissionEnd <= gameEnd) {
    throw new Error("submissionEnd must be after gameEnd");
  }

  return {
    registrationStartDelay: hasRegistration ? regStart - now : 0,
    registrationEndDelay: hasRegistration ? regEnd - regStart : 0,
    gameStartDelay: gameStart - now,
    gameEndDelay: gameEnd - gameStart,
    submissionDuration: submissionEnd - gameEnd,
  };
}
