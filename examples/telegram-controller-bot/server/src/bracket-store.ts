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

export interface StoredBracket {
  state: BracketState;
  /** chatId of the organizer (whose session deploys + advances the matches). */
  organizerChatId: string;
  /** Chat to post the public bracket tree + updates to (channel or organizer DM). */
  announceChatId: string;
  /** Optional organizer blurb shown on the card. */
  description?: string;
  /** Match ids whose winners the bot has already auto-entered into the next round. */
  entered?: string[];
  /** Lowercased player address → their Telegram chat id (captured on self-join),
   *  so the poller can DM players proactive play/submit/claim prompts. */
  playerChats?: Record<string, string>;
  /** Notification keys already sent (e.g. "<matchId>:live"), to avoid repeats. */
  notified?: string[];
  /**
   * Up-front "open" brackets are deployed with placeholder slots before joins.
   * `paid` is the per-entry fee players add on join (absent ⇒ free entry);
   * `seed` is the sponsor amount escrowed at deploy (before anyone joins, so the
   * prize is trustlessly locked). At least one is present on a filling bracket.
   */
  paid?: { tokenAddress: string; fee: string; tiersBps: number[]; label: string };
  /** Target roster size for a paid up-front bracket (power of two). */
  capacity?: number;
  /** Round-1 slots assigned so far (paid up-front brackets). */
  filled?: number;
  /** "filling" while a paid up-front bracket gathers players; else live/running. */
  phase?: "filling" | "live";
  /** The public registration card's location, so taps can edit it in place. */
  cardChatId?: string;
  cardMessageId?: number;
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
      // Only bracket files. The announce-channel setting lives in this same dir
      // as announce-channel.json — reading it as a bracket would crash callers
      // (it has no `.state`), which previously killed the poller once /channel
      // was set.
      if (!entry.endsWith(".json") || entry === "announce-channel.json") continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, entry), "utf8")) as StoredBracket;
        // Guard against any other non-bracket / partial file.
        if (parsed?.state?.status) out.push(parsed);
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

  // ----- announce channel (set via /bracket_channel; replaces the env var) -----

  private announceFile(): string {
    return join(this.dir(), "announce-channel.json");
  }

  /** Remember which chat to post bracket cards/updates to. */
  async setAnnounceChannel(chatId: string): Promise<void> {
    const file = this.announceFile();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ chatId })}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  async getAnnounceChannel(): Promise<string | null> {
    return readAnnounceChannel(this.rootDir);
  }
}

/**
 * Read the announce channel (set via /channel) without a BracketStore instance —
 * so other flows (e.g. /create posting a tournament card) can target the same
 * channel. `dataDir` is the bot's data root (the store's rootDir).
 */
export async function readAnnounceChannel(dataDir: string): Promise<string | null> {
  const file = join(dataDir, "brackets", "announce-channel.json");
  if (!existsSync(file)) return null;
  try {
    return (JSON.parse(await readFile(file, "utf8")) as { chatId?: string }).chatId ?? null;
  } catch {
    return null;
  }
}
