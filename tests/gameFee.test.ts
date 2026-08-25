import { describe, expect, test } from "bun:test";
import {
  getGameFeeFloor,
  isGameFeeShareValid,
  minGameFeeShareBps,
  type GameFeeFloor,
} from "../src/games/gameFee.ts";
import type { Contract } from "starknet";

/** Minimal stand-in for the one method `getGameFeeFloor` reaches through. */
const contractReturning = (result: unknown): Contract =>
  ({ address: "0xgame", call: async () => result }) as unknown as Contract;

const contractThrowing = (error: unknown): Contract =>
  ({
    address: "0xgame",
    call: async () => {
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
  test("reports undeclared when the entrypoint does not exist", async () => {
    const floor = await getGameFeeFloor(
      contractThrowing(new Error("ENTRYPOINT_NOT_FOUND: game_fee_terms")),
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
    await expect(getGameFeeFloor(contractThrowing(outage))).rejects.toThrow(
      /ECONNREFUSED/,
    );
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
      getGameFeeFloor(contractThrowing(new Error("Contract not found: is not deployed"))),
    ).rejects.toThrow(/not deployed/);
  });

  test("reports a real recipient and fee", async () => {
    const floor = await getGameFeeFloor(
      contractReturning({ recipient: 0x1n, license: "terms", fee_numerator: 500 }),
    );
    expect(floor.declared).toBe(true);
    expect(floor.feeBps).toBe(500);
  });
});
