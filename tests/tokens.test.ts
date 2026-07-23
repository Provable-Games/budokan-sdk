import { describe, expect, test } from "bun:test";
import {
  findKnownToken,
  fromRawAmount,
  knownTokensForChain,
  toRawAmount,
} from "../src/tokens/index.ts";

describe("findKnownToken", () => {
  test("by symbol, case-insensitive", () => {
    expect(findKnownToken("mainnet", "strk")?.symbol).toBe("STRK");
    expect(findKnownToken("mainnet", "USDC")?.decimals).toBe(6);
  });

  test("by address in any representation (leading zeros / case)", () => {
    expect(
      findKnownToken(
        "mainnet",
        // STRK without the leading zero, uppercased — the indexer-style form.
        "0x4718F5A0FC34CC1AF16A1CDEE98FFB20C31F5CD61D6AB07201858F4287C938D",
      )?.symbol,
    ).toBe("STRK");
  });

  test("unknown tokens return undefined; sepolia catalog is the STRK/ETH subset", () => {
    expect(findKnownToken("mainnet", "DOGE")).toBeUndefined();
    expect(findKnownToken("sepolia", "USDC")).toBeUndefined();
    expect(knownTokensForChain("sepolia").map((t) => t.symbol)).toEqual(["STRK", "ETH"]);
  });
});

describe("toRawAmount / fromRawAmount", () => {
  test("scales by decimals exactly", () => {
    expect(toRawAmount("5", 18)).toBe("5000000000000000000");
    expect(toRawAmount("1.5", 18)).toBe("1500000000000000000");
    expect(toRawAmount("0.25", 6)).toBe("250000");
    expect(toRawAmount("0", 18)).toBe("0");
  });

  test("round-trips", () => {
    expect(fromRawAmount(toRawAmount("123.456", 18), 18)).toBe("123.456");
    expect(fromRawAmount(1500000n, 6)).toBe("1.5");
    expect(fromRawAmount(0n, 18)).toBe("0");
  });

  test("rejects malformed amounts instead of rounding", () => {
    expect(() => toRawAmount("1,5", 18)).toThrow();
    expect(() => toRawAmount("-1", 18)).toThrow();
    expect(() => toRawAmount("1e18", 18)).toThrow();
    // More fractional digits than the token carries: refuse, don't truncate.
    expect(() => toRawAmount("0.1234567", 6)).toThrow(/decimal places/);
    expect(() => fromRawAmount(-1n, 18)).toThrow();
  });
});
