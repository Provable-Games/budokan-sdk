import { afterEach, describe, expect, test } from "bun:test";
import { hash } from "starknet";
import type { RpcProvider } from "starknet";

import { BudokanClient } from "../src/client.js";
import {
  listChainBracketRegistrations,
  listChainBrackets,
  listChainRegistrations,
  readChainBracketDetail,
  type BracketChainEvent,
  type BracketChainSource,
} from "../src/rpc/brackets.js";

const BRACKET = "0x7c0c";
const GAME = "0x123";
const MISSING = "RPC: starknet_call 21: Requested entrypoint does not exist in the contract";

/** get_config felts: creator, game, size, settings, fee low/high, token, deadline, durations, flags, prize count, status. */
const config = (game: string, status: number, fee = 0n) => [
  "0x7b75", game, "0x4", "0x3", `0x${fee.toString(16)}`, "0x0", "0x4718", "0x6a000000", "0x258", "0x3c", "0x0", "0x1", "0x1", `0x${status.toString(16)}`,
];

type Bracket = { config: string[]; views: Record<string, string[]>; matches?: string[]; seats?: string[] };
const brackets: Record<string, Bracket> = {
  "1": {
    config: config(GAME, 3),
    views: {
      field: ["0x4"],
      matches_built: ["0x3"],
      registrant_count: ["0x4"],
      registration_allowlist_progress: ["0x0", "0x0", "0x1"],
      assignment_progress: ["0x4", "0x4"],
    },
    matches: ["7", "8", "9"],
    seats: ["0x11", "0x12", "0x13", "0x14"],
  },
  "2": {
    config: config(GAME, 0, 100n),
    views: { registrant_count: ["0x0"], protocol_fee_bps: ["0x1f4"], required_registrants: ["0x4"] },
  },
  "3": { config: config("0x999", 0), views: {} },
};

function read(missing: Set<string> = new Set()) {
  return async (entrypoint: string, calldata: string[]): Promise<string[]> => {
    const b = brackets[calldata[0]];
    if (!b) throw new Error("unknown bracket");
    if (missing.has(entrypoint)) throw new Error(MISSING);
    if (entrypoint === "get_config") return b.config;
    if (entrypoint === "match_tournament") return [b.matches![Number(calldata[1])]];
    if (entrypoint === "seat") return [b.seats![Number(calldata[1])]];
    if (entrypoint === "registration_allowlist_progress" || entrypoint === "assignment_progress")
      return b.views[entrypoint] ?? (entrypoint === "assignment_progress" ? ["0x0", "0x0"] : ["0x0", "0x0", "0x1"]);
    return b.views[entrypoint] ?? (entrypoint === "attempts_per_player" ? ["0x3"] : ["0x0"]);
  };
}

const sel = (name: string) => hash.getSelectorFromName(name);
/** Bracket 2: players 0xa and 0xb register, 0xa is refunded; bracket 1: 0xa registers. */
const EVENTS: BracketChainEvent[] = [
  { keys: [sel("Registered"), "0x1"], data: ["0xa", "0x0"], block: 110, txHash: "0xt1" },
  { keys: [sel("Registered"), "0x2"], data: ["0xb", "0x1"], block: 210, txHash: "0xt3" },
  { keys: [sel("Registered"), "0x2"], data: ["0xa", "0x0"], block: 205, txHash: "0xt2" },
  { keys: [sel("Refunded"), "0x2"], data: ["0xa"], block: 400, txHash: "0xt4" },
];
const events = async (selector: string, bracketId?: string) =>
  EVENTS.filter(
    (e) =>
      BigInt(e.keys[0]) === BigInt(selector) &&
      (bracketId === undefined || BigInt(e.keys[1]) === BigInt(bracketId)),
  );

const source = (missing?: Set<string>): BracketChainSource => ({
  block: 500,
  read: read(missing),
  events,
  createdIds: async () => [
    { id: "1", block: 100 },
    { id: "2", block: 200 },
    { id: "3", block: 300 },
  ],
});

describe("bracket chain fallback", () => {
  test("lists this game's brackets newest first in the API's shape", async () => {
    const { data } = await listChainBrackets(source(), BRACKET, { gameAddress: GAME });
    expect(data.map((b) => b.id)).toEqual(["2", "1"]);
    expect(data[0]).toMatchObject({
      contractAddress: BRACKET,
      status: 0,
      entryFee: "100",
      protocolFeeBps: 500,
      requiredRegistrants: 4,
      attemptsPerPlayer: 3,
      allowlistReady: true,
      createdAtBlock: "200",
      updatedAtBlock: "500",
    });
    expect(data[1]).toMatchObject({
      field: 4,
      tournamentIds: ["7", "8", "9"],
      assignmentCompleted: 4,
      assignmentTotal: 4,
    });
  });

  test("filters by status and pages after filtering", async () => {
    const running = await listChainBrackets(source(), BRACKET, { gameAddress: GAME, status: [3] });
    expect(running.data.map((b) => b.id)).toEqual(["1"]);
    const page = await listChainBrackets(source(), BRACKET, { gameAddress: GAME, limit: 1, offset: 1 });
    expect(page.data.map((b) => b.id)).toEqual(["1"]);
  });

  test("reads seats and matches for one bracket, and null for an unknown one", async () => {
    const detail = await readChainBracketDetail(source(), BRACKET, "1");
    expect(detail?.seats).toEqual(["0x11", "0x12", "0x13", "0x14"]);
    expect(detail?.matches).toEqual([
      { matchIndex: 0, tournamentId: "7" },
      { matchIndex: 1, tournamentId: "8" },
      { matchIndex: 2, tournamentId: "9" },
    ]);
    expect(await readChainBracketDetail(source(), BRACKET, "42")).toBeNull();
  });

  test("older classes fall back only on a missing entrypoint", async () => {
    const legacy = new Set([
      "required_registrants",
      "protocol_fee_bps",
      "is_free_roster",
      "registration_allowlist_count",
      "registration_allowlist_progress",
      "assignment_progress",
    ]);
    const { data } = await listChainBrackets(source(legacy), BRACKET, { gameAddress: GAME, status: [0] });
    expect(data[0]).toMatchObject({
      requiredRegistrants: 2,
      protocolFeeBps: 0,
      allowlistExpected: 0,
      allowlistReady: true,
      assignmentCompleted: null,
    });
    const down: BracketChainSource = {
      ...source(),
      read: async () => {
        throw new Error("fetch failed");
      },
    };
    await expect(listChainBrackets(down, BRACKET)).rejects.toThrow("fetch failed");
  });
});

describe("registration chain fallback", () => {
  test("a player's registrations across brackets, with refunds", async () => {
    const rows = await listChainRegistrations(source(), BRACKET, { player: "0x00a" });
    expect(rows.map((r) => [r.bracketId, r.registrationIndex, r.refunded, r.txHash])).toEqual([
      ["1", 0, false, "0xt1"],
      ["2", 0, true, "0xt2"],
    ]);
  });

  test("one bracket's registrations in registration order, filtered and paged", async () => {
    const all = await listChainBracketRegistrations(source(), "2");
    expect(all.map((r) => [r.registrationIndex, r.player, r.refunded])).toEqual([
      [0, "0xa", true],
      [1, "0xb", false],
    ]);
    expect((await listChainBracketRegistrations(source(), "2", { player: "0xb" })).length).toBe(1);
    expect((await listChainBracketRegistrations(source(), "2", { offset: 1, limit: 5 }))[0].player).toBe("0xb");
  });
});

describe("BudokanClient brackets", () => {
  const realFetch = globalThis.fetch;
  let client: BudokanClient | null = null;
  afterEach(() => {
    globalThis.fetch = realFetch;
    client?.destroy();
    client = null;
  });

  const provider = {
    getBlockWithTxHashes: async () => ({ block_number: 500, timestamp: 1 }),
    callContract: async ({ entrypoint, calldata }: { entrypoint: string; calldata: string[] }) =>
      read()(entrypoint, calldata.map(String)),
    getEvents: async ({ keys }: { keys: string[][] }) => {
      if (BigInt(keys[0][0]) !== BigInt(sel("BracketCreated")))
        return {
          events: (await events(keys[0][0], keys[1]?.[0])).map((e) => ({
            keys: e.keys,
            data: e.data,
            block_number: e.block,
            transaction_hash: e.txHash,
          })),
        };
      return {
        events: ["1", "2", "3"].map((id, i) => ({
          keys: [sel("BracketCreated"), `0x${Number(id).toString(16)}`],
          data: [],
          block_number: 100 * (i + 1),
        })),
      };
    },
  } as unknown as RpcProvider;

  const make = (extra: { bracketCacheMs?: number } = {}) =>
    (client = new BudokanClient({
      apiBaseUrl: "https://api",
      rpcUrl: "https://rpc",
      provider,
      bracketAddress: BRACKET,
      retryAttempts: 1,
      retryDelay: 0,
      health: { initialCheckDelay: 60_000, checkInterval: 60_000 },
      ...extra,
    }));

  test("uses the API when it answers", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: [{ id: "9", tournamentIds: [] }], limit: 50, offset: 0 }));
    }) as unknown as typeof fetch;
    const result = await make().getBrackets({ gameAddress: GAME });
    expect(result.data.map((b) => b.id)).toEqual(["9"]);
    expect(urls[0]).toStartWith("https://api/brackets");
  });

  test("falls back to the bracket contract when the API errors", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    const result = await make().getBrackets({ gameAddress: GAME });
    expect(result.data.map((b) => b.id)).toEqual(["2", "1"]);
  });

  test("asks the chain for a bracket the indexer has not seen yet", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Bracket not found" }), { status: 404 })) as unknown as typeof fetch;
    const c = make();
    expect((await c.getBracket("1"))?.tournamentIds).toEqual(["7", "8", "9"]);
    expect(await c.getBracket("42")).toBeNull();
    // A 404 is an answer, not an outage.
    expect(c.getConnectionStatus().mode).toBe("api");
  });

  test("falls back to the chain for a player's registrations", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch;
    const rows = await make().getPlayerBracketRegistrations("0xb");
    expect(rows.map((r) => [r.bracketId, r.registrationIndex])).toEqual([["2", 1]]);
  });

  test("callers share one request and reuse its answer briefly", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [], limit: 50, offset: 0 }));
    }) as unknown as typeof fetch;
    const c = make({ bracketCacheMs: 60_000 });
    await Promise.all([c.getBrackets({ gameAddress: GAME }), c.getBrackets({ gameAddress: GAME })]);
    await c.getBrackets({ gameAddress: GAME });
    expect(calls).toBe(1);
    await c.getBrackets({ gameAddress: "0x999" });
    expect(calls).toBe(2);
    const fresh = make({ bracketCacheMs: 0 });
    await fresh.getBrackets({ gameAddress: GAME });
    await fresh.getBrackets({ gameAddress: GAME });
    expect(calls).toBe(4);
  });

  test("a failed read is not reused", async () => {
    let calls = 0;
    let fail = true;
    globalThis.fetch = (async () => {
      calls++;
      return fail
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify({ data: [], limit: 50, offset: 0 }));
    }) as unknown as typeof fetch;
    // API only: no RPC to fall back to, so the failure reaches the caller.
    client = new BudokanClient({ apiBaseUrl: "https://api", retryAttempts: 1, retryDelay: 0, bracketCacheMs: 60_000 });
    await expect(client.getBrackets()).rejects.toThrow();
    fail = false;
    expect((await client.getBrackets()).data).toEqual([]);
    expect(calls).toBe(2);
  });
});
