import { describe, expect, test } from "bun:test";
import { normalizeAddress } from "../src/utils/address.ts";

describe("normalizeAddress", () => {
  test("pads and lowercases to the canonical 66-char form", () => {
    expect(normalizeAddress("0xABC")).toBe("0x" + "abc".padStart(64, "0"));
    expect(normalizeAddress("0x1")).toBe("0x" + "1".padStart(64, "0"));
  });

  test("accepts a missing 0x prefix and strips leading zeros", () => {
    expect(normalizeAddress("abc")).toBe(normalizeAddress("0x0abc"));
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeAddress("  0xabc \n")).toBe(normalizeAddress("0xabc"));
  });

  test("collapses zero representations to the zero address", () => {
    const zero = "0x" + "0".repeat(64);
    expect(normalizeAddress("0x0")).toBe(zero);
    expect(normalizeAddress("0x000")).toBe(zero);
  });

  // The bug this guards: a stray space (or any non-hex char) from a copy/paste
  // used to survive normalization and fail later as an opaque BigInt parse error.
  test("rejects an address with an internal space, naming the value", () => {
    expect(() => normalizeAddress("0x627b30 ac6e2f8cd2")).toThrow(/Invalid Starknet address/);
    expect(() => normalizeAddress("0x627b30 ac6e2f8cd2")).toThrow(/627b30 ac6e2f8cd2/);
  });

  test("rejects non-hex characters", () => {
    expect(() => normalizeAddress("0xdeadbeefg")).toThrow(/Invalid Starknet address/);
    expect(() => normalizeAddress("not-an-address")).toThrow(/Invalid Starknet address/);
  });

  test("rejects empty / prefix-only input instead of coercing to zero", () => {
    expect(() => normalizeAddress("")).toThrow(/Invalid Starknet address/);
    expect(() => normalizeAddress("0x")).toThrow(/Invalid Starknet address/);
  });

  test("rejects an over-wide value beyond the field element width", () => {
    expect(() => normalizeAddress("0x" + "1".repeat(65))).toThrow(/exceed the 64-digit/);
  });
});

describe("normalizeAddress prefix case", () => {
  test("uppercase 0X prefix is a valid representation", () => {
    expect(normalizeAddress("0X01")).toBe(normalizeAddress("0x1"));
  });
});
