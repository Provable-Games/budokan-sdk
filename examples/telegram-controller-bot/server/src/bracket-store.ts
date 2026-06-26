// Filesystem persistence for off-chain bracket state, mirroring session-store.
// One JSON file per bracket under <dataDir>/brackets/. The bracket's own
// `chain` field is carried inside the state, so storage is flat.
//
// State is the SDK's `BracketState` (plain JSON) plus a little bot-side
// bookkeeping (who created it, which chat to post updates to).

import { mkdir, readdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

import type { BracketState } from "@provable-games/budokan-sdk";

import type { Chain } from "./chat-state.ts";

/**
 * A bracket still gathering players (open / mix modes), before the tree is
 * deployed. Once `players.length === capacity` it's deployed into a
 * StoredBracket and the registration is removed.
 */
export interface BracketRegistration {
  id: string;
  chain: Chain;
  organizerChatId: string;
  announceChatId: string;
  game: {
    contractAddress: string;
    name: string;
    leaderboardAscending?: boolean;
    leaderboardGameMustBeOver?: boolean;
  };
  /** Per-match schedule durations (seconds). */
  length: { reg: number; game: number; sub: number };
  prize?: { tokenAddress: string; amount: string; label: string };
  /** Power-of-two target; the bracket deploys when this many have joined. */
  capacity: number;
  /** Seeded by the organizer + everyone who has joined, in seed order. */
  players: Array<{ address: string; name?: string }>;
  createdAt: number;
}

export interface StoredBracket {
  state: BracketState;
  /** chatId of the organizer (whose session deploys + advances the matches). */
  organizerChatId: string;
  /** Chat to post the public bracket tree + updates to (channel or organizer DM). */
  announceChatId: string;
  /** Match ids whose winners the bot has already auto-entered into the next round. */
  entered?: string[];
}

export class BracketStore {
  constructor(private readonly rootDir: string) {}

  private dir(): string {
    return join(this.rootDir, "brackets");
  }

  private fileFor(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`Invalid bracket id for storage: ${id}`);
    }
    return join(this.dir(), `${id}.json`);
  }

  async save(b: StoredBracket): Promise<void> {
    const file = this.fileFor(b.state.id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(b, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  async get(id: string): Promise<StoredBracket | null> {
    const file = this.fileFor(id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(await readFile(file, "utf8")) as StoredBracket;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    const file = this.fileFor(id);
    if (existsSync(file)) await rm(file).catch(() => {});
  }

  /** All persisted brackets. */
  async all(): Promise<StoredBracket[]> {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: StoredBracket[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await readFile(join(dir, entry), "utf8")) as StoredBracket);
      } catch {
        // skip corrupt/partial files
      }
    }
    return out;
  }

  /** Running brackets only (status !== "complete"). */
  async running(): Promise<StoredBracket[]> {
    return (await this.all()).filter((b) => b.state.status !== "complete");
  }

  // ----- open/mix registrations (pre-deploy) -----

  private regDir(): string {
    return join(this.rootDir, "bracket-registrations");
  }

  private regFile(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`Invalid registration id for storage: ${id}`);
    }
    return join(this.regDir(), `${id}.json`);
  }

  async saveRegistration(reg: BracketRegistration): Promise<void> {
    const file = this.regFile(reg.id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  async getRegistration(id: string): Promise<BracketRegistration | null> {
    const file = this.regFile(id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(await readFile(file, "utf8")) as BracketRegistration;
    } catch {
      return null;
    }
  }

  async deleteRegistration(id: string): Promise<void> {
    const file = this.regFile(id);
    if (existsSync(file)) await rm(file).catch(() => {});
  }

  async allRegistrations(): Promise<BracketRegistration[]> {
    const dir = this.regDir();
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: BracketRegistration[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await readFile(join(dir, entry), "utf8")) as BracketRegistration);
      } catch {
        // skip
      }
    }
    return out;
  }
}
