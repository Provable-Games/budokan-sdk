/**
 * A game's declared monetization fee.
 *
 * Budokan enforces this as a **floor** at `create_tournament`: a tournament
 * whose `game_creator_share` is below the game's declared `fee_numerator`
 * reverts. Any create flow therefore has to know the number before it lets a
 * host pick a split.
 *
 * Before v2 it came from the minigame registry (`get_game_fee_info(game_id)`
 * via denshokan). v2 retired the registry — a game token is self-bound and
 * declares its own payee and fee through the token creator surface — so this
 * module reads it from the game token directly.
 */

import type { Contract } from "starknet";
import { budokanGameCreatorInfo } from "../rpc/budokan.js";

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
  creator: string | null;
  /** License text stating the payment obligation; empty when undeclared. */
  license: string;
  /**
   * Whether the token actually implements the creator surface.
   *
   * This matters beyond presentation: Budokan refuses a NON-ZERO
   * `game_creator_share` for a token that declares no creator, because there
   * would be no payee and the share would strand pool funds. So `false` means
   * "the share must be exactly 0", not merely "the floor is 0".
   */
  declared: boolean;
}

const UNDECLARED: GameFeeFloor = {
  feeBps: 0,
  creator: null,
  license: "",
  declared: false,
};

/**
 * Read a game's declared fee floor and payee.
 *
 * Lite tokens are self-bound — the game contract IS its token — so `contract`
 * is built against the game address.
 *
 * Degrades rather than throws: a token predating the creator surface has no
 * such entrypoint and the call reverts, which is reported as `declared:
 * false` with a zero floor. That is the honest reading — the absence of a
 * declaration is information, not a failure — and it keeps a create flow from
 * breaking on older games. Use `budokanGameCreatorInfo` directly if you need
 * to distinguish a missing entrypoint from an RPC outage.
 */
export async function getGameFeeFloor(contract: Contract): Promise<GameFeeFloor> {
  try {
    const info = await budokanGameCreatorInfo(contract);
    let creator: string | null = info.creator;
    try {
      // A declared-but-zero creator cannot be paid; treat it as undeclared
      // rather than reporting a payee of 0x0.
      if (BigInt(info.creator) === 0n) creator = null;
    } catch {
      creator = null;
    }
    return {
      feeBps: Number.isFinite(info.feeNumerator) ? info.feeNumerator : 0,
      creator,
      license: info.license,
      declared: creator !== null,
    };
  } catch {
    return UNDECLARED;
  }
}

/**
 * The minimum `game_creator_share` (basis points) a tournament may set for
 * this game without `create_tournament` reverting.
 *
 * Note this is a floor, not a cap: a host may always pay the game more.
 */
export function minGameCreatorShareBps(floor: GameFeeFloor): number {
  return floor.feeBps;
}

/**
 * Whether a proposed `game_creator_share` (basis points) will be accepted by
 * `create_tournament` for this game. Mirrors the contract's two rules:
 * undeclared games must take exactly 0, declared games must be met or beaten.
 */
export function isGameCreatorShareValid(
  floor: GameFeeFloor,
  shareBps: number,
): boolean {
  if (!Number.isFinite(shareBps) || shareBps < 0) return false;
  if (!floor.declared) return shareBps === 0;
  return shareBps >= floor.feeBps;
}
