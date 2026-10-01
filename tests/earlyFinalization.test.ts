import { describe, expect, test } from "bun:test";
import { CairoCustomEnum, type Contract } from "starknet";
import { buildEnableEarlyFinalizationCall, buildEnableBracketEarlyFinalizationCall } from "../src/calldata/index.ts";
import { viewerTournamentDetail, viewerTournamentsBatch } from "../src/rpc/viewer.ts";

const address = "0x1234";
const tournament = {
  id: 1n, created_by: 1n, created_at: BigInt(Math.floor(Date.now() / 1000)),
  game_config: { game_address: 123n },
  schedule: { game_start_delay: 0n, game_end_delay: 86400n, submission_duration: 86400n },
};
function viewer(phase: unknown = undefined, batch = false): Contract {
  const result = { tournament, phase, entry_count: 2n };
  return {address, call: async () => batch ? [result] : result} as unknown as Contract;
}

describe("early completion", () => {
  test("encodes the immutable target for an ordinary tournament", () => {
    expect(buildEnableEarlyFinalizationCall(address, { tournamentId: "7", entryTarget: 2 })).toEqual({
      contractAddress: address, entrypoint: "enable_early_finalization", calldata: ["7", "2"],
    });
  });
  test("encodes bracket opt-in without changing create calldata", () => {
    expect(buildEnableBracketEarlyFinalizationCall(address, "8")).toEqual({
      contractAddress: address, entrypoint: "enable_early_finalization", calldata: ["8"],
    });
  });
  test("rejects unrepresentable IDs and entry targets", () => {
    for (const entryTarget of [0, -1, 1.5, 0x100000000, NaN]) {
      expect(() => buildEnableEarlyFinalizationCall(address, { tournamentId: "1", entryTarget })).toThrow("positive u32");
    }
    for (const id of ["0", "-1", "18446744073709551616"]) {
      expect(() => buildEnableEarlyFinalizationCall(address, { tournamentId: id, entryTarget: 2 })).toThrow("positive u64");
      expect(() => buildEnableBracketEarlyFinalizationCall(address, id)).toThrow("positive u64");
    }
  });
  test("RPC detail honors early finalization while schedule is still live", async () => {
    for (const phase of ["Finalized", { Finalized: {} }, { variant: { Live: undefined, Finalized: {} } }, new CairoCustomEnum({ Finalized: {} })]) {
      expect((await viewerTournamentDetail(viewer(phase), "1"))?.phase).toBe("finalized");
    }
  });
  test("RPC batch honors the authoritative phase too", async () => {
    const result = await viewerTournamentsBatch(viewer("Finalized", true), ["1"]);
    expect(result[0]?.phase).toBe("finalized");
  });
  test("older viewer payloads retain schedule-based phase", async () => {
    expect((await viewerTournamentDetail(viewer(), "1"))?.phase).toBe("live");
  });
  test("unknown phase fails explicitly instead of claiming a scheduled result", async () => {
    await expect(viewerTournamentDetail(viewer("InvalidPhase"), "1")).rejects.toThrow("unknown tournament phase");
  });
});
