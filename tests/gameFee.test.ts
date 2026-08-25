import { describe, expect, test } from "bun:test";
import {
  isGameFeeShareValid,
  minGameFeeShareBps,
  type GameFeeFloor,
} from "../src/games/gameFee.ts";

const declared = (feeBps: number): GameFeeFloor => ({
  feeBps,
  creator: "0x1",
  license: "terms",
  declared: true,
});

const undeclared: GameFeeFloor = {
  feeBps: 0,
  creator: null,
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
  });
});
