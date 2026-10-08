import { afterEach, describe, expect, test } from "bun:test";
import {
  getBracket,
  getBracketRegistrations,
  getBrackets,
  getPlayerBracketRegistrations,
} from "../src/api/brackets.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(status: number, body: unknown) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return urls;
}

// retryAttempts is the total attempt count: 1 means no retry.
const noRetry = { retryAttempts: 1, retryDelay: 0 };

describe("indexed bracket API", () => {
  test("lists with game, status and paging filters", async () => {
    const urls = mockFetch(200, { data: [{ id: "3", tournamentIds: ["10"] }], limit: 5, offset: 0 });
    const result = await getBrackets("https://api", { gameAddress: "0x6", status: [0, 1], limit: 5 }, noRetry);
    expect(result.data[0].tournamentIds).toEqual(["10"]);
    expect(urls[0]).toBe("https://api/brackets?game_address=0x6&status=0%2C1&limit=5");
  });

  test("returns null for a bracket the indexer has not seen", async () => {
    mockFetch(404, { error: "Bracket not found" });
    expect(await getBracket("https://api", "99", undefined, noRetry)).toBeNull();
  });

  test("reads one bracket, its registrations and a player's registrations", async () => {
    let urls = mockFetch(200, { data: { id: "3", seats: ["0x1"], matches: [] } });
    expect((await getBracket("https://api", "3", "0xb", noRetry))?.seats).toEqual(["0x1"]);
    expect(urls[0]).toBe("https://api/brackets/3?contract_address=0xb");

    urls = mockFetch(200, { data: [{ registrationIndex: 0, player: "0x1" }] });
    expect(await getBracketRegistrations("https://api", "3", { player: "0x1" }, noRetry)).toHaveLength(1);
    expect(urls[0]).toBe("https://api/brackets/3/registrations?player=0x1");

    urls = mockFetch(200, { data: [{ bracketId: "2", registrationIndex: 1 }] });
    expect((await getPlayerBracketRegistrations("https://api", "0x1", undefined, noRetry))[0].bracketId).toBe("2");
    expect(urls[0]).toBe("https://api/brackets/registrations?player=0x1");
  });

  test("other API failures still throw", async () => {
    mockFetch(500, { error: "Internal server error" });
    await expect(getBracket("https://api", "3", undefined, noRetry)).rejects.toThrow("Internal server error");
  });
});
