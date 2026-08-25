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
import {
  budokanGameFeeTerms,
  IMINIGAME_TOKEN_GAME_FEE_ID,
} from "../rpc/budokan.js";
import { RpcError } from "../errors/index.js";

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

/**
 * Whether a failure means the caller gave up, rather than the chain answering.
 * Covers `AbortController` (DOMException "AbortError"), the SDK's own timeout
 * wrapper, and the common node/undici shapes.
 */
function isAbortOrTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  // Check the cause as well as the error itself. `wrapRpcCall` rebuilds
  // failures as `RpcError`, so by the time one arrives here its own `name` is
  // always "RpcError" — the original lives on `cause`. Without following it,
  // the name check is dead on the real call path and only the message regex
  // does any work, which is the same string-guessing this module already
  // replaced once for entrypoint detection.
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError" || name === "TimeoutError") return true;

  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== error && isAbortOrTimeout(cause)) return true;

  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /abort|timed? ?out/i.test(message);
}

/**
 * A token declared a fee that is not a basis-point rate. Distinct from
 * `RpcError` so the catch below can rethrow it without treating it as a
 * transport failure to classify.
 */
export class MalformedFeeError extends RpcError {
  constructor(message: string, contractAddress?: string) {
    super(message, contractAddress);
    // Without this the name stays "RpcError" and the distinction is
    // unobservable at runtime — the reason for the subclass in the first place.
    this.name = "MalformedFeeError";
  }
}

/** True for an integer in 0..10000; anything else is not a basis-point rate. */
function isBasisPoints(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= BPS_DENOMINATOR;
}

/**
 * Template for an undeclared floor. Callers get a COPY — this is module-level
 * and `GameFeeFloor` is mutable, so handing out the shared reference would let
 * one consumer's mutation change every later undeclared read in the process.
 */
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
    // No payee means no fee, full stop. Carrying the token's `fee_numerator`
    // through while reporting `declared: false` made the two halves of this
    // module contradict each other: `minGameFeeShareBps` would hand a create
    // flow 500 bps while `isGameFeeShareValid` rejected any non-zero share,
    // because Budokan has nowhere to route it.
    if (recipient === null) return { ...UNDECLARED };

    // `fee_numerator` is a u16, so 65535 is representable and nothing upstream
    // clamps it to basis points. Coercing it to 0 was worse than leaving it:
    // it turned a token nobody can satisfy into a valid free game, so
    // `isGameFeeShareValid(floor, 0)` said yes to a create call that reverts.
    // Malformed input is not a floor — surface it.
    if (!isBasisPoints(info.feeNumerator)) {
      throw new MalformedFeeError(
        `Game declares a fee_numerator outside 0-${BPS_DENOMINATOR} basis points ` +
          `(${info.feeNumerator}); no share can satisfy it`,
        contract.address,
      );
    }

    return {
      feeBps: info.feeNumerator,
      recipient,
      license: info.license,
      declared: true,
    };
  } catch (error: unknown) {
    // Our own validation failure, raised inside the `try` above. Rethrow
    // before the probe: it is not a transport failure to classify, the probe
    // would cost a wasted round-trip, and a probe answering `false` would
    // swallow it as "declares nothing" — turning a malformed token back into
    // a valid free game, which is the bug the throw was added to fix.
    if (error instanceof MalformedFeeError) throw error;

    // A cancelled or timed-out read is not a token without a surface. Probing
    // after an abort issues a SECOND request against a caller who has already
    // walked away, and if that probe answers `false` the call resolves to a
    // zero floor — so a cancelled read can still commit stale state.
    if (isAbortOrTimeout(error)) throw error;

    // Degrade ONLY for a token that has no game-fee surface. Everything else —
    // an RPC outage, a bad provider, a contract built from the wrong ABI, a
    // cancelled request — must propagate.
    //
    // Collapsing them was wrong in a specific and quiet way: a transient RPC
    // failure reported a 0% floor for a game that requires 5%, the create flow
    // offered a share below the floor, and `create_tournament` reverted with a
    // message pointing at the wrong cause. Nothing surfaced the real fault.
    // Ask the token whether it has the surface, rather than guessing from the
    // error text. A regex over messages was the wrong mechanism: starknet.js
    // does not reliably say ENTRYPOINT_NOT_FOUND — a missing entrypoint often
    // arrives as a generic contract error or a nested `execution_error` — so a
    // legitimately old token would have thrown instead of degrading, which is
    // the create-flow break this degradation exists to prevent.
    //
    // SRC5 answers this directly: `false` for a token without the surface, and
    // an error only when the call itself cannot be made. So a false is
    // authoritative, and anything else re-raises the ORIGINAL failure — the
    // one the caller needs to see.
    if (await lacksGameFeeSurface(contract)) return { ...UNDECLARED };
    throw error;
  }
}

/**
 * Whether the token positively reports that it does not implement the game-fee
 * surface.
 *
 * Only a clean `false` counts. If the probe itself fails — wrong address,
 * wrong chain, RPC down — this returns `false` too, so the caller re-raises
 * the original error instead of reporting a fee-less game. Silence is never
 * read as an answer here.
 */
async function lacksGameFeeSurface(contract: Contract): Promise<boolean> {
  try {
    const supported = await contract.call("supports_interface", [
      IMINIGAME_TOKEN_GAME_FEE_ID,
    ]);
    // `GAME_FEE_ABI` types this `core::bool`, so v9 decodes a JS boolean —
    // but unwrap a boxed result too. If a future parsing change returned
    // `[false]` or `{ "0": false }`, an un-normalised compare would match
    // neither branch, report "surface present", and throw on a legitimately
    // old token: the create-flow break this degradation exists to prevent,
    // reached through a decoding detail.
    const value = Array.isArray(supported)
      ? supported[0]
      : supported !== null && typeof supported === "object"
        ? Object.values(supported)[0]
        : supported;
    // Accept every falsy felt shape, not just the two v9 happens to produce.
    // A decoding change to `0` or `"0"` would otherwise fall through, report
    // "surface present", and rethrow for a legitimately old token — and tests
    // returning a real `false` would never notice.
    return (
      value === false ||
      value === 0 ||
      value === 0n ||
      value === "0" ||
      value === "0x0"
    );
  } catch {
    return false;
  }
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
