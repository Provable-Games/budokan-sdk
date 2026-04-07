import type { Contract } from "starknet";
import { CairoCustomEnum } from "starknet";
import type { Tournament } from "../types/tournament.js";
import type { EntryRequirement, Distribution } from "@provable-games/metagame-sdk";
import type { LeaderboardEntry } from "../types/leaderboard.js";
import type { Registration } from "../types/registration.js";
import type { Prize } from "../types/prize.js";
import type { PaginatedResult } from "../types/common.js";
import type { Phase } from "../types/tournament.js";
import { RpcError } from "../errors/index.js";
import { num } from "starknet";

// =========================================================================
// Helpers
// =========================================================================

function wrapRpcCall<T>(fn: () => Promise<T>, contractAddress?: string): Promise<T> {
  return fn().catch((error: unknown) => {
    throw new RpcError(
      error instanceof Error ? error.message : "RPC call failed",
      contractAddress,
    );
  });
}

function decodeShortString(value: unknown): string {
  if (!value) return "";
  const hex = num.toHex(value as bigint);
  if (hex === "0x0") return "";
  const hexStr = hex.slice(2);
  let result = "";
  for (let i = 0; i < hexStr.length; i += 2) {
    const charCode = parseInt(hexStr.slice(i, i + 2), 16);
    if (charCode === 0) break;
    result += String.fromCharCode(charCode);
  }
  return result;
}

function decodeByteArray(value: unknown): string {
  if (!value) return "";
  // ByteArray from Cairo is serialized as { data: felt252[], pending_word: felt252, pending_word_len: u32 }
  const obj = value as Record<string, unknown>;
  const data = obj.data as unknown[] | undefined;
  const pendingWord = obj.pending_word;
  const pendingWordLen = Number(obj.pending_word_len ?? 0);

  let result = "";

  // Each data element is a 31-byte chunk encoded as felt252
  if (data) {
    for (const chunk of data) {
      const hex = num.toHex(chunk as bigint).slice(2).padStart(62, "0");
      for (let i = 0; i < 62; i += 2) {
        const charCode = parseInt(hex.slice(i, i + 2), 16);
        if (charCode !== 0) result += String.fromCharCode(charCode);
      }
    }
  }

  // Pending word contains remaining bytes (< 31)
  if (pendingWord && pendingWordLen > 0) {
    const hex = num.toHex(pendingWord as bigint).slice(2).padStart(pendingWordLen * 2, "0");
    for (let i = 0; i < pendingWordLen * 2; i += 2) {
      const charCode = parseInt(hex.slice(i, i + 2), 16);
      if (charCode !== 0) result += String.fromCharCode(charCode);
    }
  }

  return result;
}

/** All Phase variant names for CairoCustomEnum */
const PHASE_VARIANTS = ["Scheduled", "Registration", "Staging", "Live", "Submission", "Finalized"] as const;

const PHASE_NAME_MAP: Record<Phase, string> = {
  scheduled: "Scheduled",
  registration: "Registration",
  staging: "Staging",
  live: "Live",
  submission: "Submission",
  finalized: "Finalized",
};

/** Convert SDK Phase string to Cairo enum argument for RPC calls */
function phaseToRpcArg(phase: Phase): CairoCustomEnum {
  const activeVariant = PHASE_NAME_MAP[phase];
  const variants: Record<string, unknown> = {};
  for (const v of PHASE_VARIANTS) {
    variants[v] = v === activeVariant ? {} : undefined;
  }
  return new CairoCustomEnum(variants);
}

// =========================================================================
// Parsers — raw on-chain structs → SDK types
// =========================================================================

function parseTournament(
  raw: unknown,
  entryCount: number,
): Tournament {
  const obj = raw as Record<string, unknown>;
  const id = String(obj.id ?? "0");
  const createdAt = Number(obj.created_at ?? 0);
  const createdBy = num.toHex(obj.created_by as bigint);
  const creatorTokenId = obj.creator_token_id ? num.toHex(obj.creator_token_id as bigint) : null;

  // Metadata
  const metadata = obj.metadata as Record<string, unknown> | undefined;
  const name = metadata ? decodeShortString(metadata.name) : "";
  const description = metadata ? decodeByteArray(metadata.description) : "";

  // Schedule
  const sched = obj.schedule as Record<string, unknown> | undefined;
  const registrationStartDelay = Number(sched?.registration_start_delay ?? 0);
  const registrationEndDelay = Number(sched?.registration_end_delay ?? 0);
  const gameStartDelay = Number(sched?.game_start_delay ?? 0);
  const gameEndDelay = Number(sched?.game_end_delay ?? 0);
  const submissionDuration = Number(sched?.submission_duration ?? 0);

  // Compute absolute timestamps (matching contract: each delay is relative to its anchor)
  const createdAtStr = String(createdAt);
  const regStart = createdAt + registrationStartDelay;
  const regEnd = regStart + registrationEndDelay;
  const gameStart = createdAt + gameStartDelay;
  const gameEnd = gameStart + gameEndDelay;
  const subEnd = gameEnd + submissionDuration;
  const registrationStartTime = String(regStart);
  const registrationEndTime = String(regEnd);
  const gameStartTime = String(gameStart);
  const gameEndTime = String(gameEnd);
  const submissionEndTime = String(subEnd);

  // GameConfig
  const gc = obj.game_config as Record<string, unknown> | undefined;
  const gameAddress = gc ? num.toHex(gc.game_address as bigint) : "";
  const settingsId = Number(gc?.settings_id ?? 0);
  const soulbound = Boolean(gc?.soulbound);
  const paymaster = Boolean(gc?.paymaster);
  const clientUrl = gc?.client_url ? decodeOptionalByteArray(gc.client_url) : null;
  const renderer = gc?.renderer ? parseOptionalAddress(gc.renderer) : null;

  // LeaderboardConfig
  const lc = obj.leaderboard_config as Record<string, unknown> | undefined;
  const ascending = Boolean(lc?.ascending);
  const gameMustBeOver = Boolean(lc?.game_must_be_over);

  // EntryFee (Option)
  const entryFeeRaw = parseOption(obj.entry_fee);
  let entryFeeToken: string | null = null;
  let entryFeeAmount: string | null = null;
  let entryFee: Tournament["entryFee"] = null;
  if (entryFeeRaw) {
    const ef = entryFeeRaw as Record<string, unknown>;
    entryFeeToken = num.toHex(ef.token_address as bigint);
    entryFeeAmount = String(ef.amount ?? "0");
    entryFee = {
      tokenAddress: entryFeeToken,
      amount: entryFeeAmount,
      tournamentCreatorShare: Number(ef.tournament_creator_share ?? 0),
      gameCreatorShare: Number(ef.game_creator_share ?? 0),
      refundShare: Number(ef.refund_share ?? 0),
      distribution: (ef.distribution as Distribution) ?? null,
      distributionCount: Number(ef.distribution_count ?? 0),
    };
  }

  // EntryRequirement (Option)
  const entryRequirement = parseOption(obj.entry_requirement) as EntryRequirement | null;
  const hasEntryRequirement = entryRequirement !== null;

  return {
    id,
    tournamentId: id,
    gameAddress,
    createdAt: new Date(createdAt * 1000).toISOString(),
    createdBy,
    creatorTokenId,
    name,
    description,
    registrationStartDelay,
    registrationEndDelay,
    gameStartDelay,
    gameEndDelay,
    submissionDuration,
    createdAtOnchain: createdAtStr,
    registrationStartTime,
    registrationEndTime,
    gameStartTime,
    gameEndTime,
    submissionEndTime,
    settingsId,
    soulbound,
    paymaster,
    clientUrl,
    renderer,
    leaderboardAscending: ascending,
    leaderboardGameMustBeOver: gameMustBeOver,
    entryFeeToken,
    entryFeeAmount,
    hasEntryRequirement,
    schedule: {
      registrationStartDelay,
      registrationEndDelay,
      gameStartDelay,
      gameEndDelay,
      submissionDuration,
    },
    gameConfig: {
      gameAddress,
      settingsId,
      soulbound,
      paymaster,
      clientUrl,
      renderer,
    },
    entryFee,
    entryRequirement,
    leaderboardConfig: { ascending, gameMustBeOver },
    entryCount,
    prizeCount: 0, // Not available from viewer
    submissionCount: 0, // Not available from viewer
    metadata: null,
  };
}

function parseLeaderboardEntry(raw: unknown): LeaderboardEntry {
  const obj = raw as Record<string, unknown>;
  return {
    position: Number(obj.position ?? 0),
    tokenId: num.toHex(obj.token_id as bigint),
  };
}

function parseRegistration(raw: unknown, tournamentId: string): Registration {
  const obj = raw as Record<string, unknown>;
  return {
    tournamentId,
    gameTokenId: num.toHex(obj.game_token_id as bigint),
    gameAddress: "", // Not in on-chain struct
    playerAddress: "", // Not in on-chain struct
    entryNumber: Number(obj.entry_id ?? 0),
    hasSubmitted: Boolean(obj.has_submitted),
    isBanned: Boolean(obj.is_banned),
  };
}

function parsePrize(raw: unknown): Prize {
  const obj = raw as Record<string, unknown>;
  const tokenTypeData = obj.token_type as Record<string, unknown> | undefined;

  // TokenTypeData is a Cairo enum: { erc20: ERC20Data } or { erc721: ERC721Data }
  let tokenType: "erc20" | "erc721" = "erc20";
  let amount: string | null = null;
  let tokenId: string | null = null;
  let distributionType: string | null = null;
  let distributionWeight: number | null = null;
  let distributionCount: number | null = null;
  let payoutPosition = 0;

  if (tokenTypeData) {
    // starknet.js v9 returns CairoCustomEnum with the active variant as a
    // non-undefined property. Check activeVariant() or the property value.
    const activeVariant = typeof tokenTypeData.activeVariant === "function"
      ? (tokenTypeData.activeVariant as () => string)()
      : tokenTypeData.erc20 !== undefined ? "erc20"
      : tokenTypeData.erc721 !== undefined ? "erc721"
      : null;

    // starknet.js v9 nests data under .variant.{name} or directly under .{name}
    const variantData = (tokenTypeData as Record<string, unknown>).variant as Record<string, unknown> | undefined;
    const unwrap = (name: string) =>
      (variantData?.[name] ?? tokenTypeData[name]) as Record<string, unknown> | undefined;

    if (activeVariant === "erc20") {
      const erc20 = unwrap("erc20");
      tokenType = "erc20";
      amount = String(erc20?.amount ?? "0");

      // distribution is Option<Distribution> — unwrap the Option then the enum
      const distOption = erc20?.distribution as Record<string, unknown> | undefined;
      const distInner = distOption?.Some as Record<string, unknown> | undefined;
      if (distInner) {
        // Distribution enum: { variant: { Linear: n } } or { Linear: n }
        const distVariant = (distInner.variant ?? distInner) as Record<string, unknown>;
        const distType = Object.keys(distVariant).find((k) => distVariant[k] !== undefined);
        if (distType) {
          distributionType = distType.toLowerCase();
          const distValue = distVariant[distType];
          distributionWeight = distValue != null ? Number(distValue) : null;
        }
      }

      // distribution_count is Option<u32>
      const countOption = erc20?.distribution_count as Record<string, unknown> | undefined;
      distributionCount = countOption?.Some != null ? Number(countOption.Some) : null;
    } else if (activeVariant === "erc721") {
      const erc721 = unwrap("erc721");
      tokenType = "erc721";
      tokenId = String(erc721?.id ?? "0");
    }
  }

  return {
    prizeId: String(obj.id ?? "0"),
    tournamentId: String(obj.context_id ?? "0"),
    payoutPosition,
    tokenAddress: num.toHex(obj.token_address as bigint),
    tokenType,
    amount,
    tokenId,
    distributionType,
    distributionWeight,
    distributionCount,
    sponsorAddress: num.toHex(obj.sponsor_address as bigint),
  };
}

/** Unwrap a Cairo Option — starknet.js may return { Some: value } / { None: {} } or just the value */
function parseOption(raw: unknown): unknown | null {
  if (raw === undefined || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if ("Some" in obj) return obj.Some;
  if ("None" in obj) return null;
  // Some starknet.js versions flatten the option
  return raw;
}

function decodeOptionalByteArray(raw: unknown): string | null {
  const inner = parseOption(raw);
  if (!inner) return null;
  return decodeByteArray(inner);
}

function parseOptionalAddress(raw: unknown): string | null {
  const inner = parseOption(raw);
  if (!inner) return null;
  const hex = num.toHex(inner as bigint);
  return hex === "0x0" ? null : hex;
}

// =========================================================================
// Viewer functions
// =========================================================================

interface TournamentFilterResult {
  tournamentIds: string[];
  total: number;
}

function parseFilterResult(raw: unknown): TournamentFilterResult {
  const obj = raw as Record<string, unknown>;
  const ids = (obj.tournament_ids as unknown[])?.map((v) => String(v)) ?? [];
  const total = Number(obj.total ?? 0);
  return { tournamentIds: ids, total };
}

function parseTournamentFullState(raw: unknown): Tournament {
  const obj = raw as Record<string, unknown>;
  const entryCount = Number(obj.entry_count ?? 0);
  return parseTournament(obj.tournament, entryCount);
}

// --- Tournament listing ---

export async function viewerTournaments(
  contract: Contract,
  offset: number,
  limit: number,
): Promise<TournamentFilterResult> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournaments", [offset, limit]);
    return parseFilterResult(result);
  }, contract.address);
}

export async function viewerTournamentsByGame(
  contract: Contract,
  gameAddress: string,
  offset: number,
  limit: number,
): Promise<TournamentFilterResult> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournaments_by_game", [gameAddress, offset, limit]);
    return parseFilterResult(result);
  }, contract.address);
}

export async function viewerTournamentsByCreator(
  contract: Contract,
  creator: string,
  offset: number,
  limit: number,
): Promise<TournamentFilterResult> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournaments_by_creator", [creator, offset, limit]);
    return parseFilterResult(result);
  }, contract.address);
}

/**
 * Map a single SDK phase to the group of on-chain phases it represents.
 * "scheduled" includes Scheduled + Registration + Staging (all pre-game).
 * "live" includes Live + Submission (active gameplay).
 * "finalized" stays as-is.
 */
const PHASE_GROUPS: Record<Phase, Phase[]> = {
  scheduled: ["scheduled", "registration", "staging"],
  registration: ["registration"],
  staging: ["staging"],
  live: ["live", "submission"],
  submission: ["submission"],
  finalized: ["finalized"],
};

export async function viewerTournamentsByPhase(
  contract: Contract,
  phase: Phase,
  offset: number,
  limit: number,
): Promise<TournamentFilterResult> {
  const phases = PHASE_GROUPS[phase];
  if (phases.length === 1) {
    return wrapRpcCall(async () => {
      const result = await contract.call("tournaments_by_phase", [phaseToRpcArg(phase), offset, limit]);
      return parseFilterResult(result);
    }, contract.address);
  }
  return wrapRpcCall(async () => {
    const result = await contract.call("tournaments_by_phases", [phases.map(phaseToRpcArg), offset, limit]);
    return parseFilterResult(result);
  }, contract.address);
}

// --- Tournament detail ---

export async function viewerTournamentDetail(
  contract: Contract,
  tournamentId: string,
): Promise<Tournament | null> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournament_detail", [tournamentId]);
    const tournament = parseTournamentFullState(result);
    // Viewer returns a zero-filled struct for non-existent tournaments
    if (!tournament.gameAddress || tournament.gameAddress === "0x0") return null;
    return tournament;
  }, contract.address);
}

export async function viewerTournamentsBatch(
  contract: Contract,
  tournamentIds: string[],
): Promise<Tournament[]> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournaments_batch", [tournamentIds]);
    return (result as unknown[]).map(parseTournamentFullState);
  }, contract.address);
}

// --- Registrations ---

export async function viewerRegistrations(
  contract: Contract,
  tournamentId: string,
  offset: number,
  limit: number,
): Promise<PaginatedResult<Registration>> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournament_registrations", [tournamentId, offset, limit]);
    const obj = result as Record<string, unknown>;
    const entries = (obj.entries as unknown[]) ?? [];
    const total = Number(obj.total ?? 0);
    return {
      data: entries.map((e) => parseRegistration(e, tournamentId)),
      total,
      limit,
      offset,
    };
  }, contract.address);
}

// --- Leaderboard ---

export async function viewerLeaderboard(
  contract: Contract,
  tournamentId: string,
  offset: number,
  limit: number,
): Promise<LeaderboardEntry[]> {
  return wrapRpcCall(async () => {
    const result = await contract.call("leaderboard", [tournamentId, offset, limit]);
    return (result as unknown[]).map(parseLeaderboardEntry);
  }, contract.address);
}

// --- Prizes ---

export async function viewerPrizes(
  contract: Contract,
  tournamentId: string,
): Promise<Prize[]> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournament_prizes", [tournamentId]);
    return (result as unknown[]).map(parsePrize);
  }, contract.address);
}

// --- Reward Claims ---

export interface ViewerRewardClaim {
  rewardType: Record<string, unknown>;
  claimed: boolean;
}

export interface ViewerRewardClaimResult {
  claims: ViewerRewardClaim[];
  total: number;
  totalClaimed: number;
  totalUnclaimed: number;
}

export async function viewerRewardClaims(
  contract: Contract,
  tournamentId: string,
  offset: number,
  limit: number,
): Promise<ViewerRewardClaimResult> {
  return wrapRpcCall(async () => {
    const result = await contract.call("tournament_reward_claims", [tournamentId, offset, limit]);
    const obj = result as Record<string, unknown>;
    const claims = (obj.claims as unknown[])?.map((raw) => {
      const claim = raw as Record<string, unknown>;
      return {
        rewardType: claim.reward_type as Record<string, unknown>,
        claimed: Boolean(claim.claimed),
      };
    }) ?? [];
    return {
      claims,
      total: Number(obj.total ?? 0),
      totalClaimed: Number(obj.total_claimed ?? 0),
      totalUnclaimed: Number(obj.total_unclaimed ?? 0),
    };
  }, contract.address);
}

// --- Player Tournaments ---

export async function viewerPlayerTournaments(
  contract: Contract,
  playerAddress: string,
  offset: number,
  limit: number,
): Promise<TournamentFilterResult> {
  return wrapRpcCall(async () => {
    const result = await contract.call("player_tournaments", [playerAddress, offset, limit]);
    return parseFilterResult(result);
  }, contract.address);
}
