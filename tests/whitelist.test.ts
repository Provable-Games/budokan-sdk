import { describe, expect, test } from "bun:test";
import {
  findWhitelistedGame,
  getGameDefaults,
  getWhitelistedGames,
  isGameWhitelisted,
} from "../src/games/whitelist.ts";

describe("getWhitelistedGames", () => {
  test("returns games sorted by name", () => {
    const games = getWhitelistedGames("sepolia");
    expect(games.length).toBeGreaterThan(0);
    const names = games.map((g) => g.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  test("addresses are canonical (lowercase, 66 chars)", () => {
    for (const g of getWhitelistedGames("mainnet")) {
      expect(g.contractAddress).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  test("returns a fresh copy each call (no shared mutation)", () => {
    const a = getWhitelistedGames("mainnet");
    a.pop();
    expect(getWhitelistedGames("mainnet").length).toBe(a.length + 1);
  });
});

describe("findWhitelistedGame / isGameWhitelisted", () => {
  test("normalizes padding before matching", () => {
    const known = getWhitelistedGames("sepolia")[0]!;
    // Strip the canonical zero-padding to a short form and re-pad differently.
    const short = "0x" + known.contractAddress.slice(2).replace(/^0+/, "");
    expect(findWhitelistedGame("sepolia", short)?.name).toBe(known.name);
    expect(isGameWhitelisted("sepolia", short)).toBe(true);
  });

  test("unknown address is not whitelisted", () => {
    expect(findWhitelistedGame("mainnet", "0xdead")).toBeUndefined();
    expect(isGameWhitelisted("mainnet", "0xdead")).toBe(false);
  });
});

describe("getGameDefaults", () => {
  test("inherits values from a known game", () => {
    const game = getWhitelistedGames("mainnet").find(
      (g) => g.name === "Death Mountain",
    )!;
    const defaults = getGameDefaults("mainnet", game.contractAddress);
    expect(defaults.defaultGameFeePercentage).toBe(5);
    expect(defaults.defaultEntryFeeToken).toBe(game.defaultEntryFeeToken);
  });

  test("falls back to chain defaults for unknown game", () => {
    const defaults = getGameDefaults("mainnet", "0xunknown");
    expect(defaults.defaultGameFeePercentage).toBe(1);
    expect(defaults.minEntryFeeUsd).toBe(0.25);
    expect(defaults.leaderboardAscending).toBe(false);
    expect(defaults.leaderboardGameMustBeOver).toBe(false);
  });
});
