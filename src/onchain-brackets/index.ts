/**
 * On-chain bracket contract client (budokan `packages/bracket`).
 *
 * Unlike `src/brackets/` — which orchestrates a bracket *off-chain* by emitting
 * `create_tournament` calls directly — this module is a thin client for the
 * on-chain bracket contract, which owns the trustless bits: entry-fee escrow,
 * VRF-driven seeding, the gated match tree, the final prize, and overflow
 * refunds. Use it for **open / uncapped** brackets (register until a deadline,
 * then the largest power-of-two that filled is bracketed and the rest refunded).
 *
 * Flow: `create_bracket` (organizer) → players `register` (escrow their fee) →
 * a permissionless init bot closes registration, consumes the VRF seed, and
 * builds the tree to RUNNING (auto-entering round-1 players). This module covers
 * the two user-facing writes (create + register); the init bot drives the rest.
 */
import { CallData, hash, uint256, type Call } from "starknet";

/** Lifecycle status (mirrors packages/bracket `status`). */
export const BRACKET_STATUS = {
  REGISTERING: 0,
  ASSIGNING: 1,
  BUILDING: 2,
  RUNNING: 3,
  COMPLETE: 4,
} as const;

export type BracketStatus =
  (typeof BRACKET_STATUS)[keyof typeof BRACKET_STATUS];

/**
 * Inputs for `create_bracket`. `size` is the capacity: `0` = uncapped (register
 * until `registrationDeadline`, then bracket the largest power-of-two that
 * filled), or a power of two `>= 2` for a fixed bracket. Amounts/ids are the raw
 * on-chain values. `creator`/`status`/`prize_distribution_count` are set by the
 * contract, so they're not part of the input.
 */
export interface CreateBracketConfig {
  /** Game contract every match tournament uses. */
  game: string;
  /** Capacity: 0 = uncapped, else a power of two >= 2. */
  size: number;
  /** Game settings id applied to every match. */
  settingsId: number;
  /** Entry fee per player, escrowed on register (raw base units; 0 = free). */
  entryFee: bigint | string;
  /** ERC-20 the entry fee is denominated + escrowed in. */
  feeToken: string;
  /** Registration closes at this unix time (also the round-1 start anchor). */
  registrationDeadline: number | bigint;
  /** Per-match game duration, seconds. */
  gameDuration: number | bigint;
  /** Per-match score-submission window, seconds. */
  submissionDuration: number | bigint;
  /** Leaderboard ordering for every match: true = lower score wins. */
  leaderboardAscending: boolean;
  /** Whether the game must report over before a score can be submitted. */
  gameMustBeOver: boolean;
}

/**
 * `create_bracket(config: BracketConfig, prize_tiers: Array<u16>) -> u64`
 *
 * `prizeTiers` splits the escrowed fee pool across the final match's placements
 * (basis points, must sum to 10000): empty or a single tier ⇒ champion-take-all;
 * `> 1` ⇒ a distributed final prize (index 0 = champion, 1 = runner-up, …).
 * Additional sponsor prizes are added separately (via budokan `add_prize` on the
 * final match) after creation — not here.
 */
export function buildCreateBracketCall(
  bracketAddress: string,
  config: CreateBracketConfig,
  prizeTiers: number[] = [],
): Call {
  const calldata = CallData.compile({
    config: {
      // Overwritten on-chain (caller becomes creator); serialized for Serde.
      creator: 0,
      game: config.game,
      size: config.size,
      settings_id: config.settingsId,
      entry_fee: uint256.bnToUint256(config.entryFee),
      fee_token: config.feeToken,
      registration_deadline: config.registrationDeadline,
      game_duration: config.gameDuration,
      submission_duration: config.submissionDuration,
      leaderboard_ascending: config.leaderboardAscending,
      game_must_be_over: config.gameMustBeOver,
      // Derived from prize_tiers on-chain; overwritten. Status starts REGISTERING.
      prize_distribution_count: 0,
      status: BRACKET_STATUS.REGISTERING,
    },
    prize_tiers: prizeTiers,
  });
  return { contractAddress: bracketAddress, entrypoint: "create_bracket", calldata };
}

/**
 * `register(bracket_id: u64, recipient: ContractAddress)` — the CALLER escrows
 * the entry fee, the RECIPIENT is seated + plays (mirrors Budokan's
 * `enter_tournament` recipient). Pass the caller's own address to self-register,
 * or another address to sponsor them.
 */
export function buildBracketRegisterCall(
  bracketAddress: string,
  bracketId: number | bigint,
  recipient: string,
): Call {
  return {
    contractAddress: bracketAddress,
    entrypoint: "register",
    calldata: CallData.compile([bracketId, recipient]),
  };
}

/**
 * The full register multicall: `approve(bracket, fee)` on the fee token (only
 * when `entryFee > 0`) followed by `register(bracket_id, recipient)`. The
 * approve lets the contract pull the escrow from the caller in `register`'s
 * `transfer_from`. Pass `recipient` = the caller's own address for a normal
 * signup, or another address to sponsor that player (the caller still pays).
 */
export function buildBracketRegisterCalls(
  bracketAddress: string,
  feeToken: string,
  bracketId: number | bigint,
  recipient: string,
  entryFee: bigint | string = 0n,
): Call[] {
  const calls: Call[] = [];
  const fee = BigInt(entryFee);
  if (fee > 0n) {
    calls.push({
      contractAddress: feeToken,
      entrypoint: "approve",
      calldata: CallData.compile([bracketAddress, uint256.bnToUint256(fee)]),
    });
  }
  calls.push(buildBracketRegisterCall(bracketAddress, bracketId, recipient));
  return calls;
}

const BRACKET_CREATED_SELECTOR = hash.getSelectorFromName("BracketCreated");

interface ReceiptWithEvents {
  events?: Array<{ from_address?: string; keys?: string[] }>;
}

/**
 * Extract the new bracket id from a `create_bracket` tx receipt by scanning for
 * the `BracketCreated` event (`bracket_id` is its first indexed key). Returns a
 * `bigint` (u64 on-chain) or `undefined` if not found.
 */
export function parseBracketIdFromReceipt(
  receipt: ReceiptWithEvents,
  bracketAddress: string,
): bigint | undefined {
  const normalise = (addr: string) => addr.toLowerCase().replace(/^0x0*/, "0x");
  const normContract = normalise(bracketAddress);
  const createdSelector = BigInt(BRACKET_CREATED_SELECTOR);
  for (const event of receipt.events ?? []) {
    if (!event.from_address || !event.keys || event.keys.length < 2) continue;
    if (normalise(event.from_address) !== normContract) continue;
    if (BigInt(event.keys[0]!) !== createdSelector) continue;
    return BigInt(event.keys[1]!);
  }
  return undefined;
}
