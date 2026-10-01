import { describe, expect, test } from "bun:test";
import { CairoCustomEnum, type Contract } from "starknet";
import { viewerTournamentDetail, viewerTournamentsBatch } from "../src/rpc/viewer.ts";

const address = "0x1234";
const tournament = {
  id: 1n, created_by: 1n, created_at: BigInt(Math.floor(Date.now() / 1000) - 3600),
  game_config: { game_address: 123n },
  schedule: { game_start_delay: 0n, game_end_delay: 3600n, submission_duration: 86400n },
};
function viewer(phase: unknown = undefined, batch = false): Contract {
  const result = { tournament, phase, entry_count: 2n };
  return {address, call: async () => batch ? [result] : result} as unknown as Contract;
}

describe("early completion", () => {
  test("RPC detail honors early finalization during the submission grace period", async () => {
    for (const phase of ["Finalized", { Finalized: {} }, { variant: { Submission: undefined, Finalized: {} } }, new CairoCustomEnum({ Finalized: {} })]) {
      expect((await viewerTournamentDetail(viewer(phase), "1"))?.phase).toBe("finalized");
    }
  });
  test("RPC batch honors the authoritative phase too", async () => {
    const result = await viewerTournamentsBatch(viewer("Finalized", true), ["1"]);
    expect(result[0]?.phase).toBe("finalized");
  });
  test("older viewer payloads retain schedule-based phase", async () => {
    expect((await viewerTournamentDetail(viewer(), "1"))?.phase).toBe("submission");
  });
  test("unknown phase fails explicitly instead of claiming a scheduled result", async () => {
    await expect(viewerTournamentDetail(viewer("InvalidPhase"), "1")).rejects.toThrow("unknown tournament phase");
  });
});
