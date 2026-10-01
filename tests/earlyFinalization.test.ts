import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { CairoCustomEnum, type Contract } from "starknet";
import { viewerTournamentDetail, viewerTournamentsBatch } from "../src/rpc/viewer.ts";
import { BudokanClient } from "../src/client.ts";
import { getGameTournaments } from "../src/api/games.ts";

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

describe("indexed API completion", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
  afterEach(() => fetchSpy?.mockRestore());
  const raw = {
    id: "1", created_at_onchain: tournament.created_at.toString(),
    schedule: { registration_start_delay: 0, registration_end_delay: 0,
      game_start_delay: 0, game_end_delay: 3600, submission_duration: 86400 },
    entry_count: 2, submission_count: 2, ranked_entry_count: 1,
    phase: "submission",
  };
  const mockFetch = (response: () => unknown) => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => Response.json(response()), { preconnect: () => {} }),
    );
  };

  test("default API detail refetch observes restoration of a displaced entry", async () => {
    let response = raw;
    mockFetch(() => ({ data: response }));
    const client = new BudokanClient({ apiBaseUrl: "https://example.com", retryAttempts: 1 });
    try {
      const displaced = await client.getTournament("1");
      expect(displaced?.submissionCount).toBe(2);
      expect(displaced?.rankedEntryCount).toBe(1);
      expect(displaced?.phase).toBe("submission");
      response = { ...raw, ranked_entry_count: 2, phase: "finalized" };
      expect((await client.getTournament("1"))?.phase).toBe("finalized");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally { client.destroy(); }
  });

  test("default API lists and game lists honor the returned phase", async () => {
    mockFetch(() => ({ data: [{ ...raw, ranked_entry_count: 2, phase: "finalized" }],
      pagination: { total: 1, limit: 20, offset: 0 } }));
    const client = new BudokanClient({ apiBaseUrl: "https://example.com", retryAttempts: 1 });
    try {
      expect((await client.getTournaments()).data[0]?.phase).toBe("finalized");
      const gameList = await getGameTournaments("https://example.com", "0x1234");
      expect(gameList.data[0]?.phase).toBe("finalized");
      expect(gameList.data[0]?.tournamentId).toBe("1");
    } finally { client.destroy(); }
  });

  test("older API payloads derive scheduled phase without treating historical submissions as completion", async () => {
    const { phase: _phase, ranked_entry_count: _rankedCount, ...older } = raw;
    mockFetch(() => ({ data: older }));
    const client = new BudokanClient({ apiBaseUrl: "https://example.com", retryAttempts: 1 });
    try {
      expect((await client.getTournament("1"))?.phase).toBe("submission");
    } finally { client.destroy(); }
  });
});
