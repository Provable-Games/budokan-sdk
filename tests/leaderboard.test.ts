import { describe, expect, test } from "bun:test";
import {
  comparePacketTokenScores,
  getSubmittableScores,
  buildSubmitScoreCalls,
} from "../src/leaderboard/index.ts";

describe("getSubmittableScores", () => {
  test("assigns 1-indexed positions by rank order", () => {
    const ranked = ["0xaaa", "0xbbb", "0xccc"];
    expect(getSubmittableScores(ranked, [])).toEqual([
      { tokenId: "0xaaa", position: 1 },
      { tokenId: "0xbbb", position: 2 },
      { tokenId: "0xccc", position: 3 },
    ]);
  });

  test("skips already-submitted tokens but keeps remaining positions by rank", () => {
    const ranked = ["0xaaa", "0xbbb", "0xccc"];
    // 0xbbb already on the leaderboard → only aaa (pos 1) and ccc (pos 3) remain.
    expect(getSubmittableScores(ranked, ["0xbbb"])).toEqual([
      { tokenId: "0xaaa", position: 1 },
      { tokenId: "0xccc", position: 3 },
    ]);
  });

  test("matches submitted ids by numeric value across hex/decimal/padding", () => {
    const ranked = ["0x0a", "11", "0x00c"];
    // submitted given as decimal "10" should match ranked "0x0a".
    expect(getSubmittableScores(ranked, ["10"])).toEqual([
      { tokenId: "11", position: 2 },
      { tokenId: "0x00c", position: 3 },
    ]);
  });

  test("returns empty when everything is submitted", () => {
    expect(getSubmittableScores(["0x1", "0x2"], ["0x1", "0x2"])).toEqual([]);
  });
});

describe("buildSubmitScoreCalls", () => {
  test("builds one submit_score call per submission, in order", () => {
    const calls = buildSubmitScoreCalls("0xbudokan", "7", [
      { tokenId: "0xaaa", position: 1 },
      { tokenId: "0xbbb", position: 2 },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.contractAddress).toBe("0xbudokan");
    expect(calls[0]!.entrypoint).toBe("submit_score");
    expect(calls[1]!.entrypoint).toBe("submit_score");
  });
});

describe("packet token ranking", () => {
  const token = (minutes: bigint, payload = 0n, nonce = 0n) =>
    (1n | (minutes << 64n) | (payload << 192n) | (nonce << 21n)).toString();
  for (const ascending of [false, true]) {
    test(`earlier mint wins even if payload reverses ID order (${ascending})`, () => {
      const earlier = { score: 100n, tokenId: token(100n, 1n) };
      const later = { score: 100n, tokenId: token(101n) };
      expect(BigInt(earlier.tokenId) > BigInt(later.tokenId)).toBe(true);
      expect(
        [later, earlier].sort((a, b) => comparePacketTokenScores(a, b, ascending)),
      ).toEqual([earlier, later]);
    });
    test(`same-minute mint uses numerical ID across hex/decimal (${ascending})`, () => {
      const first = {
        score: "100",
        tokenId: "0x" + BigInt(token(100n)).toString(16),
      };
      const second = { score: "100", tokenId: token(100n, 0n, 1n) };
      expect(comparePacketTokenScores(first, second, ascending)).toBe(-1);
      expect(comparePacketTokenScores(second, first, ascending)).toBe(1);
      expect(
        comparePacketTokenScores(
          first,
          { ...first, tokenId: BigInt(first.tokenId).toString() },
          ascending,
        ),
      ).toBe(0);
    });
    test(`score precedes mint, preserving u64 precision (${ascending})`, () => {
      const earlier = { score: "18446744073709551614", tokenId: token(100n) };
      const later = { score: "18446744073709551615", tokenId: token(101n) };
      expect(comparePacketTokenScores(earlier, later, ascending)).toBe(ascending ? -1 : 1);
    });
  }
});
