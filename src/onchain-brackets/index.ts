/**
 * On-chain bracket contract client (budokan `packages/bracket`).
 *
 * Unlike `src/brackets/` — which orchestrates a bracket *off-chain* by emitting
 * `create_tournament` calls directly — this module is a thin client for the
 * on-chain bracket contract, which owns the trustless bits: entry-fee escrow,
 * committed block-hash seeding, the gated match tree, the final prize, and overflow
 * refunds. Use it for **open / uncapped** brackets (register until a deadline,
 * then the largest power-of-two that filled is bracketed and the rest refunded).
 *
 * Flow: `create_bracket` (organizer) → players `register` (escrow their fee) →
 * a permissionless init bot closes registration, waits for the committed block, and
 * draws and builds the tree to RUNNING (auto-entering round-1 players). This
 * module exposes creation, registration, commitment, draw and build calls.
 */
import { CallData, hash, uint256, type Call } from "starknet";
import { MAX_ALLOWLIST_ENTRY_COUNT } from "../extensions/merkle.js";

/** Lifecycle status (mirrors packages/bracket `status`). */
export const BRACKET_STATUS = {
  REGISTERING: 0,
  ASSIGNING: 1,
  BUILDING: 2,
  RUNNING: 3,
  COMPLETE: 4,
  CANCELLED: 5,
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
  /** Attempts per player per round; defaults to 1. Values >1 require the
   * bracket deployment with create_bracket_with_attempts support. */
  attemptsPerPlayer?: number;
  /** Preparation time before the shared first-round start (60..86400 seconds).
   * Requires create_bracket_with_setup. Use 3600 for large brackets. */
  setupWindow?: number;
  /** Require every fixed-capacity seat, or cancel/refund after the deadline.
   * Setting either true or false opts into create_bracket_with_requirements;
   * omitted preserves the legacy creation ABI. Defaults setupWindow to 3600. */
  requireFull?: boolean;
  /** Entry fee per player, escrowed on register (raw base units; 0 = free). */
  entryFee: bigint | string;
  /** ERC-20 the entry fee is denominated + escrowed in. */
  feeToken: string;
  /** Registration deadline. Buffered brackets start after the later of this
   * deadline and the first build, plus setup time; read play_start for the anchor. */
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
  const attempts = config.attemptsPerPlayer ?? 1;
  const policy = config.requireFull;
  if (policy !== undefined && typeof policy !== "boolean") throw new Error("requireFull must be boolean");
  if (policy && config.size === 0) throw new Error("requireFull needs a fixed size");
  const setup = config.setupWindow ?? (policy !== undefined ? 3600 : undefined);
  if (setup !== undefined && (!Number.isInteger(setup) || setup < 60 || setup > 86400)) {
    throw new Error("setupWindow must be an integer from 60 to 86400 seconds");
  }
  if (!Number.isInteger(config.size) || config.size < 0 || config.size > 1024 ||
      (config.size !== 0 && (config.size < 2 || (config.size & (config.size - 1)) !== 0))) {
    throw new Error("size must be 0 or a power of two from 2 to 1024");
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ALLOWLIST_ENTRY_COUNT) {
    throw new Error(`attemptsPerPlayer must be an integer from 1 to ${MAX_ALLOWLIST_ENTRY_COUNT}`);
  }
  if (attempts > 1 && prizeTiers.length > 1) {
    throw new Error("Multiple attempts require winner-take-all prizes; placements rank game tokens, not unique players");
  }
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
    // Keep the existing entrypoint/calldata for default single-attempt brackets.
    ...(attempts > 1 || setup !== undefined ? { attempts_per_player: attempts } : {}),
    ...(setup !== undefined ? { setup_window: setup } : {}),
    ...(policy !== undefined ? { require_full: policy } : {}),
  });
  return { contractAddress: bracketAddress, entrypoint: policy !== undefined ? "create_bracket_with_requirements" : setup !== undefined ? "create_bracket_with_setup" : attempts > 1 ? "create_bracket_with_attempts" : "create_bracket", calldata };
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

/** @deprecated Legacy VRF deployments only. New block-hash brackets must use the separate
 * close and assignment calls below; this multicall reverts against block-hash
 * deployments. Close registration, request VRF, and consume it in
 * one transaction. Submit through a Cartridge session/paymaster supporting VRF;
 * a plain account cannot fulfill the randomness request by itself. */
export function buildBracketSeedCalls(
  bracketAddress: string, vrfAddress: string, bracketId: number | bigint,
  needsClose = true,
): Call[] {
  const id = BigInt(bracketId).toString();
  return [
    { contractAddress: vrfAddress, entrypoint: "request_random", calldata: [bracketAddress, "1", id] },
    ...(needsClose ? [{ contractAddress: bracketAddress, entrypoint: "close_registration", calldata: [id] }] : []),
    { contractAddress: bracketAddress, entrypoint: "fulfill_assignment", calldata: [id] },
  ];
}

/** Resume on-chain match creation in bounded chunks after the draw. */
export function buildBracketMatchesCall(
  bracketAddress: string, bracketId: number | bigint, maxMatches: number,
): Call {
  if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 255) {
    throw new Error("maxMatches must be an integer from 1 to 255");
  }
  return { contractAddress: bracketAddress, entrypoint: "build_matches", calldata: CallData.compile([bracketId, maxMatches]) };
}

/** Freeze registrations and commit the next block as entropy. */
export function buildBracketCloseCall(bracketAddress: string, bracketId: number | bigint): Call {
  return { contractAddress: bracketAddress, entrypoint: "close_registration", calldata: CallData.compile([bracketId]) };
}

/** Upgrade recovery only: commit once when status is ASSIGNING and entropy_block
 * is zero because registration closed under the old VRF class. New brackets
 * commit in close_registration. This cannot replace an existing commitment. */
export function buildBracketCommitCall(bracketAddress: string, bracketId: number | bigint): Call {
  return { contractAddress: bracketAddress, entrypoint: "commit_assignment", calldata: CallData.compile([bracketId]) };
}

/** Draw from the committed block after assignment_ready returns true.
 * This must be a later transaction than close_registration. Any account works. */
export function buildBracketAssignmentCall(bracketAddress: string, bracketId: number | bigint): Call {
  return { contractAddress: bracketAddress, entrypoint: "fulfill_assignment", calldata: CallData.compile([bracketId]) };
}

/** Recover unpayable placements of the bracket's own final prize. Zero uses
 * the saved ID; pre-upgrade builds need the original PrizeAdded ID. */
export function buildBracketRecoverEntryPoolCall(
  bracketAddress: string, bracketId: number | bigint, prizeId: number | bigint = 0n,
): Call {
  const id = BigInt(prizeId);
  if (id < 0n || id >= 1n << 64n) throw new Error("prizeId must fit u64");
  return { contractAddress: bracketAddress, entrypoint: "recover_entry_pool", calldata: CallData.compile([bracketId, id]) };
}

/** Permissionless proof-based payout. The contract matches the registration to
 * its shuffled seat and always pays the original payer, never the caller. */
export function buildBracketRefundEntryPoolCall(
  bracketAddress: string, bracketId: number | bigint, registrationIndex: number, seatIndex: number,
): Call {
  for (const value of [registrationIndex, seatIndex]) {
    if (!Number.isInteger(value) || value < 0 || value >= 1024) throw new Error("refund indices must be integers from 0 to 1023");
  }
  return { contractAddress: bracketAddress, entrypoint: "refund_entry_pool", calldata: CallData.compile([bracketId, registrationIndex, seatIndex]) };
}
