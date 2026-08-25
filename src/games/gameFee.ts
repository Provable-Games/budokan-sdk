/**
 * A game's declared monetization fee.
 *
 * Budokan enforces this as a **floor** at `create_tournament`: a tournament
 * whose `game_fee_share` is below the game's declared `fee_numerator`
 * reverts. Any create flow therefore has to know the number before it lets a
 * host pick a split.
 *
 * Before v2 it came from the minigame registry (`get_game_fee_info(game_id)`
 * via denshokan). v2 retired the registry — a game token is self-bound and
 * declares its own payee and fee through the token's game-fee surface — so this
 * module reads it from the game token directly.
 */

import type { Contract } from "starknet";
import { budokanGameFeeTerms } from "../rpc/budokan.js";

export interface GameFeeFloor {
  /**
   * Basis points the game requires. 0 when the game declares nothing, which
   * is also the floor Budokan applies to such a game.
   */
  feeBps: number;
  /**
   * Address the share is paid to, or null when undeclared. Resolved LIVE by
   * the contract at claim time — a game whose owner rotates the payout
   * address is paid at the new one for anything unclaimed, so do not cache
   * this against a tournament.
   */
  recipient: string | null;
  /** License text stating the payment obligation; empty when undeclared. */
  license: string;
  /**
   * Whether the token actually implements the game-fee surface.
   *
   * This matters beyond presentation: Budokan refuses a NON-ZERO
   * `game_fee_share` for a token that declares no fee recipient, because there
   * would be no payee and the share would strand pool funds. So `false` means
   * "the share must be exactly 0", not merely "the floor is 0".
   */
  declared: boolean;
}

/** Basis-point denominator; shares are integers in 0..10000. */
const BPS_DENOMINATOR = 10_000;

const UNDECLARED: GameFeeFloor = {
  feeBps: 0,
  recipient: null,
  license: "",
  declared: false,
};

/**
 * Read a game's declared fee floor and payee.
 *
 * Lite tokens are self-bound — the game contract IS its token — so `contract`
 * is built against the game address.
 *
 * Degrades ONLY for a missing surface: a token predating the game-fee surface
 * has no such entrypoint, and that is reported as `declared: false` with a
 * zero floor. The absence of a declaration is information, not a failure, and
 * treating it as one would break create flows on older games.
 *
 * Every other failure throws. An RPC outage is not a game declining to charge,
 * and reporting it as one produces a create call the contract rejects for a
 * reason the error never mentions.
 */
export async function getGameFeeFloor(contract: Contract): Promise<GameFeeFloor> {
  try {
    const info = await budokanGameFeeTerms(contract);
    let recipient: string | null = info.recipient;
    try {
      // A declared-but-zero recipient cannot be paid; treat it as undeclared
      // rather than reporting a payee of 0x0.
      if (BigInt(info.recipient) === 0n) recipient = null;
    } catch {
      recipient = null;
    }
    return {
      feeBps: Number.isFinite(info.feeNumerator) ? info.feeNumerator : 0,
      recipient,
      license: info.license,
      declared: recipient !== null,
    };
  } catch (error: unknown) {
    // Degrade ONLY for a token that has no game-fee surface. Everything else —
    // an RPC outage, a bad provider, a contract built from the wrong ABI, a
    // cancelled request — must propagate.
    //
    // Collapsing them was wrong in a specific and quiet way: a transient RPC
    // failure reported a 0% floor for a game that requires 5%, the create flow
    // offered a share below the floor, and `create_tournament` reverted with a
    // message pointing at the wrong cause. Nothing surfaced the real fault.
    if (isMissingEntrypoint(error)) return UNDECLARED;
    throw error;
  }
}

/**
 * Whether a call failed because the entrypoint does not exist, rather than
 * because the call could not be made.
 *
 * Starknet reports this as ENTRYPOINT_NOT_FOUND — deliberately narrow, so an
 * unrecognised failure propagates instead of being read as "declares nothing".
 */
function isMissingEntrypoint(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /ENTRYPOINT_NOT_FOUND|Entry ?point .* not found|is not deployed/i.test(message);
}

/**
 * The minimum `game_fee_share` (basis points) a tournament may set for
 * this game without `create_tournament` reverting.
 *
 * Note this is a floor, not a cap: a host may always pay the game more.
 */
export function minGameFeeShareBps(floor: GameFeeFloor): number {
  return floor.feeBps;
}

/**
 * Whether a proposed `game_fee_share` (basis points) will be accepted by
 * `create_tournament` for this game. Mirrors the contract's two rules:
 * undeclared games must take exactly 0, declared games must be met or beaten.
 */
export function isGameFeeShareValid(
  floor: GameFeeFloor,
  shareBps: number,
): boolean {
  // Basis points are integers in 0..10000. `buildCreateTournamentCall` throws
  // on anything else, so accepting `0.5` or `10001` here would bless a value
  // the very call this pre-validates then rejects — which defeats the point of
  // pre-validating.
  if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > BPS_DENOMINATOR) {
    return false;
  }
  if (!floor.declared) return shareBps === 0;
  return shareBps >= floor.feeBps;
}
