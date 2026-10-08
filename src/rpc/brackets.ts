/**
 * Chain fallback for the indexed bracket API: the same `IndexedBracket` shape the Budokan API
 * serves, read straight from the bracket contract (packages/bracket) at one block.
 *
 * Brackets are found from `BracketCreated` events; each bracket's configuration and progress
 * views are read at the same block, so a row is never a mix of two chain states. Views added
 * by later contract classes fall back to the first class's behaviour only when the entrypoint
 * is missing; any other RPC failure is thrown, so the caller sees it rather than a guess.
 */

import { hash } from "starknet";
import type { RpcProvider } from "starknet";

import type {
  BracketListParams,
  BracketRegistration,
  IndexedBracket,
  IndexedBracketDetail,
  PlayerBracketRegistration,
} from "../types/indexedBracket.js";
import { decodeBracketAssignmentProgress, decodeRegistrationAllowlistProgress } from "../onchain-brackets/index.js";

const BRACKET_CREATED = hash.getSelectorFromName("BracketCreated");
const REGISTERED = hash.getSelectorFromName("Registered");
const REFUNDED = hash.getSelectorFromName("Refunded");
/** Concurrent view calls per request burst; public nodes drop larger bursts. */
const CONCURRENCY = 8;

export type BracketChainRead = (entrypoint: string, calldata: string[]) => Promise<string[]>;

export interface BracketChainEvent {
  keys: string[];
  data: string[];
  block: number;
  txHash: string | null;
}

export interface BracketChainSource {
  read: BracketChainRead;
  /** Bracket ids from `BracketCreated`, with the block each was created at. */
  createdIds(): Promise<Array<{ id: string; block: number }>>;
  /** The contract's events with this selector (optionally one bracket's), oldest first. */
  events(selector: string, bracketId?: string): Promise<BracketChainEvent[]>;
  /** The block every read is pinned to. */
  block: number;
}

const hex = (felt: string | bigint) => `0x${BigInt(felt).toString(16)}`;

function u32(felt: string | undefined, name: string): number {
  if (felt === undefined) throw new Error(`Missing ${name}`);
  const n = BigInt(felt);
  if (n < 0n || n > 0xffffffffn) throw new Error(`${name} out of u32 range`);
  return Number(n);
}

export function isMissingEntrypoint(error: unknown): boolean {
  return /ENTRYPOINT_NOT_FOUND|entry\s*point[^\n]*not found|requested entrypoint does not exist/i.test(
    String(error),
  );
}

async function single(read: BracketChainRead, entrypoint: string, calldata: string[]) {
  const r = await read(entrypoint, calldata);
  if (r.length !== 1) throw new Error(`${entrypoint} returned ${r.length} felts, expected 1`);
  return r[0];
}

/** Views the first mainnet class lacked, with the behaviour that class had. */
const LEGACY_VIEW_DEFAULTS: Record<string, string> = {
  required_registrants: "2",
  registration_allowlist_count: "0",
  protocol_fee_bps: "0",
  is_free_roster: "0",
};

async function view(read: BracketChainRead, entrypoint: string, id: string) {
  try {
    return await single(read, entrypoint, [id]);
  } catch (error) {
    const legacy = LEGACY_VIEW_DEFAULTS[entrypoint];
    if (legacy !== undefined && isMissingEntrypoint(error)) return legacy;
    throw error;
  }
}

async function optional<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (isMissingEntrypoint(error)) return null;
    throw error;
  }
}

/** Run `tasks` with at most `limit` in flight, keeping their order. */
async function pool<T>(tasks: Array<() => Promise<T>>, limit = CONCURRENCY): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** One bracket as the API serves it; null when it belongs to another game. */
export async function readChainBracket(
  source: BracketChainSource,
  contractAddress: string,
  id: string,
  createdAtBlock: number,
  gameAddress?: string,
): Promise<IndexedBracket | null> {
  const { read } = source;
  const cfg = await read("get_config", [id]);
  if (cfg.length !== 14) throw new Error(`get_config returned ${cfg.length} felts, expected 14`);
  if (gameAddress && BigInt(cfg[1]) !== BigInt(gameAddress)) return null;
  const [attempts, playStart, required, allowlistCount, feeBps, registrants, field, built, free] =
    await pool(
      [
        "attempts_per_player",
        "play_start",
        "required_registrants",
        "registration_allowlist_count",
        "protocol_fee_bps",
        "registrant_count",
        "field",
        "matches_built",
        "is_free_roster",
      ].map((v) => () => view(read, v, id)),
    );
  const registrationAllowlistCount = u32(allowlistCount, "registration_allowlist_count");
  const allowlist = await optional(async () =>
    decodeRegistrationAllowlistProgress(await read("registration_allowlist_progress", [id])),
  );
  const assignment = await optional(async () =>
    decodeBracketAssignmentProgress(await read("assignment_progress", [id])),
  );
  const matchesBuilt = u32(built, "matches_built");
  const tournamentIds = (
    await pool(
      Array.from({ length: matchesBuilt }, (_, i) => () =>
        single(read, "match_tournament", [id, String(i)]),
      ),
    )
  ).map((t, i) => {
    if (BigInt(t) === 0n) throw new Error(`match_tournament(${id}, ${i}) is 0 below matches_built`);
    return BigInt(t).toString();
  });
  return {
    contractAddress: hex(contractAddress),
    id,
    creator: hex(cfg[0]),
    gameAddress: hex(cfg[1]),
    capacity: u32(cfg[2], "size"),
    settingsId: u32(cfg[3], "settings_id"),
    entryFee: (BigInt(cfg[4]) + (BigInt(cfg[5]) << 128n)).toString(),
    feeToken: hex(cfg[6]),
    registrationDeadline: Number(BigInt(cfg[7])),
    gameDuration: Number(BigInt(cfg[8])),
    submissionDuration: Number(BigInt(cfg[9])),
    leaderboardAscending: BigInt(cfg[10]) !== 0n,
    gameMustBeOver: BigInt(cfg[11]) !== 0n,
    prizeDistributionCount: u32(cfg[12], "prize_distribution_count"),
    status: u32(cfg[13], "status"),
    attemptsPerPlayer: u32(attempts, "attempts_per_player"),
    playStart: Number(BigInt(playStart)),
    requiredRegistrants: u32(required, "required_registrants"),
    registrationAllowlistCount,
    protocolFeeBps: u32(feeBps, "protocol_fee_bps"),
    registrantCount: u32(registrants, "registrant_count"),
    field: u32(field, "field"),
    matchesBuilt,
    freeRoster: BigInt(free) !== 0n,
    allowlistExpected: allowlist?.expected ?? registrationAllowlistCount,
    allowlistReady: allowlist?.ready ?? true,
    assignmentCompleted: assignment?.completed ?? null,
    assignmentTotal: assignment?.total ?? null,
    createdAtBlock: String(createdAtBlock),
    updatedAtBlock: String(source.block),
    tournamentIds,
  };
}

/** The API's `GET /brackets`, from the chain: newest first, filtered, then paged. */
export async function listChainBrackets(
  source: BracketChainSource,
  contractAddress: string,
  params: BracketListParams = {},
): Promise<{ data: IndexedBracket[]; limit: number; offset: number }> {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const created = (await source.createdIds()).sort((a, b) =>
    BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0,
  );
  const rows = (
    await pool(
      created.map(
        ({ id, block }) =>
          () =>
            readChainBracket(source, contractAddress, id, block, params.gameAddress),
      ),
      2,
    )
  ).filter(
    (b): b is IndexedBracket =>
      b !== null && (!params.status?.length || params.status.includes(b.status)),
  );
  return { data: rows.slice(offset, offset + limit), limit, offset };
}

/** The API's `GET /brackets/:id`, from the chain: null when the bracket does not exist. */
export async function readChainBracketDetail(
  source: BracketChainSource,
  contractAddress: string,
  id: string,
): Promise<IndexedBracketDetail | null> {
  const created = (await source.createdIds()).find((c) => BigInt(c.id) === BigInt(id));
  if (!created) return null;
  const bracket = await readChainBracket(source, contractAddress, BigInt(id).toString(), created.block);
  if (!bracket) return null;
  const seats = (
    await pool(
      Array.from({ length: bracket.field }, (_, i) => () =>
        single(source.read, "seat", [bracket.id, String(i)]),
      ),
    )
  ).map(hex);
  return {
    ...bracket,
    seats,
    matches: bracket.tournamentIds.map((tournamentId, matchIndex) => ({ matchIndex, tournamentId })),
  };
}

/**
 * Registrations from `Registered` events, as the API's registration routes serve them. A
 * `Refunded` event marks every registration of that player in that bracket, as the indexer does.
 * Players are event data, not keys, so a player's registrations need the contract's full scan.
 */
export async function listChainRegistrations(
  source: BracketChainSource,
  contractAddress: string,
  filter: { bracketId?: string; player?: string } = {},
): Promise<PlayerBracketRegistration[]> {
  const bracketId = filter.bracketId === undefined ? undefined : BigInt(filter.bracketId).toString();
  const [registered, refunded] = await Promise.all([
    source.events(REGISTERED, bracketId),
    source.events(REFUNDED, bracketId),
  ]);
  const refunds = new Set(
    refunded.map((e) => `${BigInt(e.keys[1]).toString()}:${BigInt(e.data[0] ?? 0)}`),
  );
  const player = filter.player === undefined ? undefined : BigInt(filter.player);
  return registered
    .filter((e) => e.keys[1] !== undefined && e.data[0] !== undefined && e.data[1] !== undefined)
    .filter((e) => player === undefined || BigInt(e.data[0]) === player)
    .map((e) => {
      const id = BigInt(e.keys[1]).toString();
      return {
        contractAddress: hex(contractAddress),
        bracketId: id,
        registrationIndex: u32(e.data[1], "Registered.index"),
        refunded: refunds.has(`${id}:${BigInt(e.data[0])}`),
        blockNumber: String(e.block),
        txHash: e.txHash,
      };
    });
}

/** One bracket's registrations in registration order, as `GET /brackets/:id/registrations`. */
export async function listChainBracketRegistrations(
  source: BracketChainSource,
  bracketId: string,
  params: { player?: string; limit?: number; offset?: number } = {},
): Promise<BracketRegistration[]> {
  const id = BigInt(bracketId).toString();
  const [registered, refunded] = await Promise.all([
    source.events(REGISTERED, id),
    source.events(REFUNDED, id),
  ]);
  const refunds = new Set(refunded.map((e) => BigInt(e.data[0] ?? 0).toString()));
  const player = params.player === undefined ? undefined : BigInt(params.player);
  const rows = registered
    .filter((e) => e.data[0] !== undefined && e.data[1] !== undefined)
    .filter((e) => player === undefined || BigInt(e.data[0]) === player)
    .map((e) => ({
      registrationIndex: u32(e.data[1], "Registered.index"),
      player: hex(e.data[0]),
      refunded: refunds.has(BigInt(e.data[0]).toString()),
      blockNumber: String(e.block),
      txHash: e.txHash,
    }))
    .sort((a, b) => a.registrationIndex - b.registrationIndex);
  const offset = params.offset ?? 0;
  return rows.slice(offset, params.limit === undefined ? undefined : offset + params.limit);
}

/** A source pinned to the provider's latest block. */
export async function createBracketChainSource(
  provider: RpcProvider,
  contractAddress: string,
  fromBlock: number,
): Promise<BracketChainSource> {
  const head = await provider.getBlockWithTxHashes("latest");
  if (!("block_number" in head)) throw new Error("Latest block is not available yet.");
  const block = head.block_number;
  const events = async (selector: string, bracketId?: string) => {
    const out: BracketChainEvent[] = [];
    let continuation_token: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const result = await provider.getEvents({
        address: contractAddress,
        keys: bracketId === undefined ? [[selector]] : [[selector], [hex(bracketId)]],
        from_block: { block_number: fromBlock },
        to_block: { block_number: block },
        chunk_size: 1000,
        continuation_token,
      });
      for (const e of result.events)
        out.push({
          keys: e.keys,
          data: e.data,
          block: Number(e.block_number ?? 0),
          txHash: e.transaction_hash ?? null,
        });
      continuation_token = result.continuation_token;
      if (!continuation_token) return out;
    }
    throw new Error("Bracket event history is too large to scan.");
  };
  return {
    block,
    read: (entrypoint, calldata) =>
      provider.callContract({ contractAddress, entrypoint, calldata }, block),
    events,
    async createdIds() {
      const ids = new Map<string, number>();
      for (const e of await events(BRACKET_CREATED))
        if (e.keys[1] !== undefined) ids.set(BigInt(e.keys[1]).toString(), e.block);
      return [...ids].map(([id, block]) => ({ id, block }));
    },
  };
}
