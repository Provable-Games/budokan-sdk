import { describe, expect, test } from "bun:test";
import {
  buildErc20BalanceConfig,
  buildMerkleConfig,
  buildOpusTrovesConfig,
  buildTournamentValidatorConfig,
  buildTournamentQualificationProof,
  u256ToLowHigh,
} from "../src/extensions/index.ts";

describe("buildTournamentQualificationProof", () => {
  test("encodes [qualifyingTournamentId, tokenId, position]", () => {
    expect(buildTournamentQualificationProof("7", "0x123", 1)).toEqual([
      "7",
      "0x123",
      "1",
    ]);
  });
});

describe("u256ToLowHigh", () => {
  test("splits into low/high limbs", () => {
    expect(u256ToLowHigh(0n)).toEqual(["0", "0"]);
    expect(u256ToLowHigh((1n << 128n))).toEqual(["0", "1"]);
    expect(u256ToLowHigh((1n << 128n) + 5n)).toEqual(["5", "1"]);
  });

  test("accepts exactly u256 max", () => {
    const max = (1n << 256n) - 1n;
    const [lo, hi] = u256ToLowHigh(max);
    expect(BigInt(lo)).toBe((1n << 128n) - 1n);
    expect(BigInt(hi)).toBe((1n << 128n) - 1n);
  });

  test("throws on negative", () => {
    expect(() => u256ToLowHigh(-1n)).toThrow();
  });

  test("throws above u256 max", () => {
    expect(() => u256ToLowHigh(1n << 256n)).toThrow();
  });
});

describe("buildErc20BalanceConfig layout", () => {
  test("[token, min(lo,hi), max(lo,hi), vpe(lo,hi), maxEntries, bannable]", () => {
    const out = buildErc20BalanceConfig({
      tokenAddress: "0xtoken",
      minThreshold: 5n,
      maxThreshold: 0n,
      valuePerEntry: (1n << 128n) + 1n,
      maxEntries: 3,
      bannable: true,
    });
    expect(out).toEqual([
      "0xtoken",
      "5", "0", // min lo/hi
      "0", "0", // max lo/hi
      "1", "1", // vpe lo/hi
      "3",
      "1",
    ]);
  });
});

describe("buildOpusTrovesConfig layout", () => {
  test("[asset_count, ...assets, threshold, vpe, maxEntries, bannable]", () => {
    expect(
      buildOpusTrovesConfig({
        assetAddresses: ["0xa", "0xb"],
        threshold: 100n,
        valuePerEntry: 10n,
        maxEntries: 0,
        bannable: false,
      }),
    ).toEqual(["2", "0xa", "0xb", "100", "10", "0", "0"]);
  });

  test("empty assets → count 0 wildcard", () => {
    expect(
      buildOpusTrovesConfig({
        assetAddresses: [],
        threshold: 1n,
        valuePerEntry: 0n,
        maxEntries: 0,
        bannable: false,
      }),
    ).toEqual(["0", "1", "0", "0", "0"]);
  });
});

describe("buildMerkleConfig", () => {
  test("[tree_id]", () => {
    expect(buildMerkleConfig({ treeId: 7 })).toEqual(["7"]);
  });
});

describe("buildTournamentValidatorConfig layout", () => {
  test("participated → qualifier 0, top_positions forced 0", () => {
    expect(
      buildTournamentValidatorConfig({
        requirement: "participated",
        tournamentIds: ["1", "2"],
        topPositions: 5,
      }),
    ).toEqual(["0", "0", "0", "1", "2"]);
  });

  test("won → qualifier 1, top_positions honored, mode passthrough", () => {
    expect(
      buildTournamentValidatorConfig({
        requirement: "won",
        tournamentIds: ["9"],
        topPositions: 3,
        qualifyingMode: 2,
      }),
    ).toEqual(["1", "2", "3", "9"]);
  });
});
