/**
 * Tournament phase derivation — the single source of truth for "what phase is
 * this tournament in right now?", mirroring the contract exactly
 * (`packages/budokan/src/libs/schedule.cairo::current_phase`).
 *
 * The client used to recompute this inline (`isStarted/isEnded/isSubmitted`);
 * this generalizes it so the client, bot, and any integration agree with the
 * chain on phase boundaries (all comparisons are strict `<`, so a boundary
 * second belongs to the *later* phase, matching the Cairo `if` ladder).
 */

import type { Phase } from "../types/tournament.js";

/** Minimal schedule + creation-time shape needed to derive a phase. Matches
 *  the relevant subset of `Tournament` (top-level delay fields + on-chain
 *  created-at), so a full `Tournament` satisfies it directly. */
export interface PhaseInput {
  /** Unix seconds (string or number) the tournament was created on-chain. */
  createdAtOnchain?: string | number | null;
  registrationStartDelay?: number | null;
  registrationEndDelay?: number | null;
  gameStartDelay?: number | null;
  gameEndDelay?: number | null;
  submissionDuration?: number | null;
  /** Fallback structured schedule (used when top-level delays are absent). */
  schedule?: {
    registrationStartDelay: number;
    registrationEndDelay: number;
    gameStartDelay: number;
    gameEndDelay: number;
    submissionDuration: number;
  } | null;
}

/**
 * Derive the current {@link Phase}. Returns `null` when the on-chain
 * creation time is unknown (can't anchor the schedule).
 *
 * @param t - tournament schedule + `createdAtOnchain`
 * @param nowSeconds - Unix seconds to evaluate at (defaults to wall-clock now).
 *   Pass an explicit value for deterministic/testable derivation.
 */
export function tournamentPhase(
  t: PhaseInput,
  nowSeconds?: number,
): Phase | null {
  const createdAt = Number(t.createdAtOnchain ?? NaN);
  if (!Number.isFinite(createdAt)) return null;

  const regStartDelay = Number(t.registrationStartDelay ?? t.schedule?.registrationStartDelay ?? 0);
  const regEndDelay = Number(t.registrationEndDelay ?? t.schedule?.registrationEndDelay ?? 0);
  const gameStartDelay = Number(t.gameStartDelay ?? t.schedule?.gameStartDelay ?? 0);
  const gameEndDelay = Number(t.gameEndDelay ?? t.schedule?.gameEndDelay ?? 0);
  const submissionDuration = Number(t.submissionDuration ?? t.schedule?.submissionDuration ?? 0);

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);

  // Registration exists when either delay is non-zero (contract: has_registration).
  const hasReg = regStartDelay > 0 || regEndDelay > 0;
  const regStart = createdAt + regStartDelay;
  const regEnd = regStart + regEndDelay;
  const gameStart = createdAt + gameStartDelay;
  const gameEnd = gameStart + gameEndDelay;
  const subEnd = gameEnd + submissionDuration;

  if (hasReg && now < regStart) return "scheduled";
  if (hasReg && now < regEnd) return "registration";
  if (now < gameStart) return "staging";
  if (now < gameEnd) return "live";
  if (now < subEnd) return "submission";
  return "finalized";
}
