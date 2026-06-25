import { describe, expect, test } from "bun:test";
import {
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
