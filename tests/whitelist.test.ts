import { describe, expect, test } from "bun:test";
import {
  findWhitelistedGame,
  getGameDefaults,
  getWhitelistedGames,
  isGameWhitelisted,
} from "../src/games/whitelist.ts";

describe("getWhitelistedGames", () => {
  test("sorts by name with disabled entries last", () => {
    // The documented order is two-key: enabled before disabled, then by
    // name. A plain name-sort assertion held only while no entry carried
    // `disabled` — the v2 whitelist has five.
    const games = getWhitelistedGames("sepolia");
    expect(games.length).toBeGreaterThan(0);
    const expected = [...games].sort((a, b) => {
      const ad = a.disabled ?? false;
      const bd = b.disabled ?? false;
      if (ad !== bd) return ad ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    expect(games.map((g) => g.name)).toEqual(expected.map((g) => g.name));
  });

  test("sepolia offers exactly one v2-compatible game", () => {
    // v2 acceptance is strict (self-bound token, matching interface ids), and
    // Death Mountain (v2) is the only sepolia game that passes
    // check_game_compatible.sh. Everything else must carry `disabled: true`
    // so pickers built on this list cannot offer a game whose
    // create_tournament reverts. A newly compatible game changes this test
    // deliberately.
    const enabled = getWhitelistedGames("sepolia").filter((g) => !g.disabled);
    expect(enabled.map((g) => g.name)).toEqual(["Death Mountain (v2)"]);
    expect(enabled[0]!.contractAddress).toBe(
      "0x016fa4b7263337504a37add061ee809b13c1de3477d7be2211447db3a77fea69",
    );
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
    // `defaultEntryFeeToken` is optional on the game record, so assert it is
    // actually present before comparing — otherwise `undefined === undefined`
    // would pass while proving nothing was inherited.
    expect(game.defaultEntryFeeToken).toBeDefined();
    expect(defaults.defaultEntryFeeToken).toBe(game.defaultEntryFeeToken!);
  });

  test("falls back to chain defaults for unknown game", () => {
    const defaults = getGameDefaults("mainnet", "0xunknown");
    expect(defaults.defaultGameFeePercentage).toBe(1);
    expect(defaults.minEntryFeeUsd).toBe(0.25);
    expect(defaults.leaderboardAscending).toBe(false);
    expect(defaults.leaderboardGameMustBeOver).toBe(false);
  });
});
