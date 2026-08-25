import { describe, expect, test } from "bun:test";
import {
  getGameFeeFloor,
  isGameFeeShareValid,
  minGameFeeShareBps,
  type GameFeeFloor,
} from "../src/games/gameFee.ts";
import type { Contract } from "starknet";
import { GAME_FEE_ABI } from "../src/rpc/budokan.ts";

/**
 * Stand-in for the two entrypoints `getGameFeeFloor` reaches through:
 * `game_fee_terms`, and the `supports_interface` probe it falls back to.
 */
const contractReturning = (result: unknown): Contract =>
  ({
    address: "0xgame",
    call: async (method: string) =>
      method === "supports_interface" ? true : result,
  }) as unknown as Contract;

/**
 * `game_fee_terms` fails; `supportsSurface` decides whether that means the
 * token has no surface (degrade) or the call could not be made (rethrow).
 */
const contractThrowing = (error: unknown, supportsSurface = false): Contract =>
  ({
    address: "0xgame",
    call: async (method: string) => {
      if (method === "supports_interface") return supportsSurface;
      throw error;
    },
  }) as unknown as Contract;

const declared = (feeBps: number): GameFeeFloor => ({
  feeBps,
  recipient: "0x1",
  license: "terms",
  declared: true,
});

const undeclared: GameFeeFloor = {
  feeBps: 0,
  recipient: null,
  license: "",
  declared: false,
};

describe("minGameFeeShareBps", () => {
  test("is the declared fee", () => {
    expect(minGameFeeShareBps(declared(500))).toBe(500);
  });

  test("is zero for a game that declares nothing", () => {
    expect(minGameFeeShareBps(undeclared)).toBe(0);
  });
});

describe("isGameFeeShareValid", () => {
  // The contract treats the declared fee as a FLOOR, not a cap.
  test("accepts a share equal to the declared fee", () => {
    expect(isGameFeeShareValid(declared(500), 500)).toBe(true);
  });

  test("accepts a share above the declared fee", () => {
    expect(isGameFeeShareValid(declared(500), 750)).toBe(true);
  });

  test("rejects a share below the declared fee", () => {
    expect(isGameFeeShareValid(declared(500), 499)).toBe(false);
  });

  // A game declaring 0% is not charging; a host may still be generous.
  test("accepts any non-negative share when the declared fee is zero", () => {
    expect(isGameFeeShareValid(declared(0), 0)).toBe(true);
    expect(isGameFeeShareValid(declared(0), 250)).toBe(true);
  });

  // Undeclared is stricter than a zero floor: there is no payee at all, so
  // the contract refuses a non-zero share rather than stranding pool funds.
  test("requires exactly zero when the game declares no creator", () => {
    expect(isGameFeeShareValid(undeclared, 0)).toBe(true);
    expect(isGameFeeShareValid(undeclared, 1)).toBe(false);
  });

  test("rejects negative and non-finite shares", () => {
    expect(isGameFeeShareValid(declared(0), -1)).toBe(false);
    expect(isGameFeeShareValid(declared(0), Number.NaN)).toBe(false);
    expect(isGameFeeShareValid(declared(0), Number.POSITIVE_INFINITY)).toBe(false);
  });

  // Basis points are integers in 0..10000. `buildCreateTournamentCall` throws
  // on anything else, so these must not be blessed here.
  test("rejects non-integer and out-of-range basis points", () => {
    expect(isGameFeeShareValid(declared(0), 0.5)).toBe(false);
    expect(isGameFeeShareValid(declared(500), 500.5)).toBe(false);
    expect(isGameFeeShareValid(declared(0), 10001)).toBe(false);
    // The boundaries themselves stay valid.
    expect(isGameFeeShareValid(declared(0), 0)).toBe(true);
    expect(isGameFeeShareValid(declared(0), 10000)).toBe(true);
  });
});

describe("getGameFeeFloor", () => {
  // A token that predates the surface has no such entrypoint. That is
  // information, not a failure — the contract applies a zero floor to a game
  // declaring nothing, so the SDK reports the same.
  test("reports undeclared when the token has no game-fee surface", async () => {
    // Deliberately an opaque error, not ENTRYPOINT_NOT_FOUND: starknet.js does
    // not reliably name the cause, which is why the SRC5 probe decides rather
    // than the message.
    const floor = await getGameFeeFloor(
      contractThrowing(new Error("Contract error"), false),
    );
    expect(floor.declared).toBe(false);
    expect(floor.feeBps).toBe(0);
    expect(floor.recipient).toBeNull();
  });

  // The failure this whole classification exists to stop swallowing. Reporting
  // an outage as "declares no fee" hands the create flow a 0% floor for a game
  // that may require 5%, and `create_tournament` then reverts for a reason the
  // error never mentions.
  test("propagates a transport failure instead of reporting no fee", async () => {
    const outage = new Error("fetch failed: ECONNREFUSED");
    await expect(
      getGameFeeFloor(contractThrowing(outage, true)),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  // A token can register the surface and still name nobody. There is no payee,
  // so Budokan requires a share of exactly 0 — the same rule as a token with no
  // surface at all, reached by a different route.
  test("normalises a zero recipient to undeclared", async () => {
    const floor = await getGameFeeFloor(
      contractReturning({ recipient: 0n, license: "", fee_numerator: 500 }),
    );
    expect(floor.recipient).toBeNull();
    expect(floor.declared).toBe(false);
    // The assertion my first pass omitted, and the reviewer caught: an
    // undeclared floor must be ZEROED, not left carrying the token's
    // fee_numerator. Otherwise minGameFeeShareBps recommends a share
    // isGameFeeShareValid rejects.
    expect(floor.feeBps).toBe(0);
    expect(minGameFeeShareBps(floor)).toBe(0);
    expect(isGameFeeShareValid(floor, 0)).toBe(true);
    expect(isGameFeeShareValid(floor, 500)).toBe(false);
  });

  // A wrong address or wrong chain is an integration error, not a game
  // declining to charge. Reporting it as undeclared hides it behind a
  // plausible zero floor.
  test("propagates an undeployed-contract error", async () => {
    await expect(
      getGameFeeFloor(
        contractThrowing(new Error("Contract not found: is not deployed"), true),
      ),
    ).rejects.toThrow(/not deployed/);
  });

  // `fee_numerator` is a u16, so 65535 is representable and nothing upstream
  // clamps it. Left through, `minGameFeeShareBps` would recommend a value
  // `buildCreateTournamentCall` rejects — the same two-halves contradiction as
  // the zero-recipient case, reached from the opposite end.
  // The probe must not get a chance to swallow our own validation error: a
  // token whose SRC5 answers `false` would otherwise turn a malformed fee back
  // into a valid free game.
  test("surfaces a malformed fee even when the surface probe says no", async () => {
    const contract = {
      address: "0xgame",
      call: async (method: string) =>
        method === "supports_interface"
          ? false
          : { recipient: 0x1n, license: "terms", fee_numerator: 65535 },
    } as unknown as Contract;
    await expect(getGameFeeFloor(contract)).rejects.toThrow(/basis points/);
  });

  // A boxed decode must still read as "no surface" rather than falling through
  // and throwing on a legitimately old token.
  test("degrades when the surface probe returns a boxed false", async () => {
    for (const boxed of [[false], { "0": false }]) {
      const contract = {
        address: "0xgame",
        call: async (method: string) => {
          if (method === "supports_interface") return boxed;
          throw new Error("Contract error");
        },
      } as unknown as Contract;
      const floor = await getGameFeeFloor(contract);
      expect(floor.declared).toBe(false);
      expect(floor.feeBps).toBe(0);
    }
  });

  test("throws on a fee_numerator outside basis points", async () => {
    // Coercing it to 0 turned a token nobody can satisfy into a valid free
    // game, so `isGameFeeShareValid(floor, 0)` said yes to a reverting call.
    await expect(
      getGameFeeFloor(
        contractReturning({ recipient: 0x1n, license: "terms", fee_numerator: 65535 }),
      ),
    ).rejects.toThrow(/basis points/);
    // The boundary itself stays valid.
    const atCeiling = await getGameFeeFloor(
      contractReturning({ recipient: 0x1n, license: "terms", fee_numerator: 10000 }),
    );
    expect(atCeiling.feeBps).toBe(10000);
  });

  // Undeclared results must not share one mutable object, or a consumer
  // mutating one corrupts every later undeclared read in the process.
  test("returns a fresh object for each undeclared read", async () => {
    const a = await getGameFeeFloor(contractThrowing(new Error("no surface"), false));
    const b = await getGameFeeFloor(contractThrowing(new Error("no surface"), false));
    expect(a).not.toBe(b);
    a.feeBps = 9999;
    expect(b.feeBps).toBe(0);
  });

  test("reports a real recipient and fee", async () => {
    const floor = await getGameFeeFloor(
      contractReturning({ recipient: 0x1n, license: "terms", fee_numerator: 500 }),
    );
    expect(floor.declared).toBe(true);
    expect(floor.feeBps).toBe(500);
  });
});

// The finding this covers: `gameFeeContract`/`GAME_FEE_ABI` were exported from
// `src/rpc/budokan.ts` but not from the entry, so no published consumer could
// reach them — and `getGameFeeFloor` takes a `Contract` they are the supported
// way to build. Importing through the entry is what makes that regression
// visible; importing the module directly would pass either way.
describe("public entry surface", () => {
  test("exposes the fee-floor read path", async () => {
    const entry = await import("../src/index.ts");
    expect(typeof entry.getGameFeeFloor).toBe("function");
    expect(typeof entry.isGameFeeShareValid).toBe("function");
    expect(typeof entry.minGameFeeShareBps).toBe("function");
    expect(typeof entry.gameFeeContract).toBe("function");
    expect(Array.isArray(entry.GAME_FEE_ABI)).toBe(true);
    // Consumers must be able to tell malformed on-chain terms from a
    // transport failure; that needs both the export and a distinct `name`.
    expect(typeof entry.MalformedFeeError).toBe("function");
    expect(new entry.MalformedFeeError("x").name).toBe("MalformedFeeError");
    expect(typeof entry.IMINIGAME_TOKEN_GAME_FEE_ID).toBe("string");
  });

  test("the exported ABI declares the entrypoints the reads call", () => {
    const names = new Set<string>();
    for (const item of GAME_FEE_ABI as Array<Record<string, unknown>>) {
      if (item.type === "interface") {
        for (const f of item.items as Array<{ name: string }>) names.add(f.name);
      }
    }
    expect(names.has("game_fee_terms")).toBe(true);
    expect(names.has("game_fee_recipient")).toBe(true);
  });
});

describe("cancellation", () => {
  // An abort is the caller giving up, not a token without a surface. Probing
  // afterwards issues a second request against someone who has walked away —
  // and if it answers `false`, the read resolves to a zero floor and the
  // caller can commit stale state from a request it cancelled.
  test("propagates an abort instead of probing and degrading", async () => {
    let probes = 0;
    const aborted = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    const contract = {
      address: "0xgame",
      call: async (method: string) => {
        if (method === "supports_interface") {
          probes += 1;
          return false; // would degrade to a zero floor if reached
        }
        throw aborted;
      },
    } as unknown as Contract;

    await expect(getGameFeeFloor(contract)).rejects.toThrow(/aborted/);
    expect(probes).toBe(0);
  });
});
