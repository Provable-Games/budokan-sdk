// Filesystem persistence for the tournaments whose lifecycle the bot broadcasts
// to a public channel. One JSON file per tournament under
// <dataDir>/tournament-watch/, namespaced by chain (ids are per-chain).
//
// A watch is added automatically when /create makes a tournament, or manually
// via /follow <id> for tournaments the bot didn't create. The poller
// (commands/watch.ts) reads each watched tournament every tick, diffs the phase
// (+ prize / submission counts) against what's stored here, and posts a card to
// `announceChatId` on each change — then updates the stored snapshot so the same
// edge isn't announced twice.

import { mkdir, readdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

import type { Chain } from "./chat-state.ts";

export interface WatchedTournament {
  tournamentId: string;
  chain: Chain;
  /** Chat to post lifecycle cards to (a channel set via /channel, or a DM). */
  announceChatId: string;
  /** Display name, cached for card text so a tick doesn't have to re-read it. */
  name?: string;
  /** Last-announced snapshot — an edge is only broadcast when one of these moves. */
  lastPhase?: string;
  lastPrizeCount?: number;
  lastSubmissionCount?: number;
  /** Unix seconds when first observed finalized. Drives the post-finalize
   *  retention window (kept until all rewards claimed, capped) so late claims
   *  still produce the "all rewards distributed" card. */
  finalizedAt?: number;
}

export class TournamentWatchStore {
  constructor(private readonly rootDir: string) {}

  private dir(): string {
    return join(this.rootDir, "tournament-watch");
  }

  private fileFor(chain: Chain, id: string): string {
    if (!/^\d+$/.test(id)) {
      throw new Error(`Invalid tournament id for storage: ${id}`);
    }
    return join(this.dir(), `${chain}-${id}.json`);
  }

  async save(w: WatchedTournament): Promise<void> {
    const file = this.fileFor(w.chain, w.tournamentId);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(w, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  async get(chain: Chain, id: string): Promise<WatchedTournament | null> {
    const file = this.fileFor(chain, id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(await readFile(file, "utf8")) as WatchedTournament;
    } catch {
      return null;
    }
  }

  async delete(chain: Chain, id: string): Promise<void> {
    const file = this.fileFor(chain, id);
    if (existsSync(file)) await rm(file).catch(() => {});
  }

  /** Every watched tournament (all chains). */
  async all(): Promise<WatchedTournament[]> {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: WatchedTournament[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, entry), "utf8")) as WatchedTournament;
        if (parsed?.tournamentId && parsed?.chain) out.push(parsed);
      } catch {
        // skip corrupt/partial files
      }
    }
    return out;
  }
}
