// Filesystem persistence for ON-CHAIN bracket state (the `packages/bracket`
// contract flow), mirroring bracket-store.ts. One JSON file per bracket under
// <dataDir>/onchain-brackets/. Unlike the off-chain BracketStore (which wraps an
// SDK BracketState tree), an on-chain bracket is just a pointer: the contract
// owns the tree/escrow/VRF, so we only track the id + display bookkeeping so the
// bot can render the registration card and route joins. Seeding/advancement is
// driven by the budokan-bots init + advance engines, not this bot.

import { mkdir, readdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

import type { Chain } from "./chat-state.ts";

export interface OnchainBracket {
  /** Synthetic storage id: `oc-<chain>-<bracketId>`. */
  id: string;
  /** The on-chain bracket id (u64 as string). */
  bracketId: string;
  /** The bracket contract address the id lives on. */
  contractAddress: string;
  chain: Chain;
  /** Capacity: 0 = uncapped (register until deadline), else a power of two. */
  size: number;
  /** chatId of the organizer whose session created it. */
  organizerChatId: string;
  /** Chat the registration card + updates post to. */
  announceChatId: string;
  /** Display name (card title); falls back to the game name. */
  namePrefix?: string;
  description?: string;
  /** Per-entry fee escrowed on register (absent ⇒ free). */
  paid?: { tokenAddress: string; fee: string; symbol: string; label: string };
  /** When registration closes (round-1 start anchor), unix seconds. */
  registrationDeadline: number;
  /** The public registration card's location, so taps can edit it in place. */
  cardChatId?: string;
  cardMessageId?: number;
  /** Addresses that have registered (best-effort, from self-join taps). */
  registered?: string[];
  /** Registered address → Cartridge username, for the card roster (best-effort:
   *  only players who registered via the bot; direct on-chain registrants are
   *  counted on-chain but not named here). */
  names?: Record<string, string>;
  createdAt: number;
  /** Unix seconds when the "round-1 is live, go play" CTA was posted to
   *  `announceChatId`. Set once (the bracket reaching RUNNING) so the lifecycle
   *  tick never double-announces. Absent ⇒ not yet announced. */
  startedAnnouncedAt?: number;
}

export class OnchainBracketStore {
  constructor(private readonly rootDir: string) {}

  private dir(): string {
    return join(this.rootDir, "onchain-brackets");
  }

  private fileFor(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`Invalid on-chain bracket id for storage: ${id}`);
    }
    return join(this.dir(), `${id}.json`);
  }

  static idFor(chain: Chain, bracketId: string): string {
    return `oc-${chain}-${bracketId}`;
  }

  async save(b: OnchainBracket): Promise<void> {
    const file = this.fileFor(b.id);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(b, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  async get(id: string): Promise<OnchainBracket | null> {
    const file = this.fileFor(id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(await readFile(file, "utf8")) as OnchainBracket;
    } catch {
      return null;
    }
  }

  async getByBracketId(chain: Chain, bracketId: string): Promise<OnchainBracket | null> {
    return this.get(OnchainBracketStore.idFor(chain, bracketId));
  }

  async delete(id: string): Promise<void> {
    const file = this.fileFor(id);
    if (existsSync(file)) await rm(file).catch(() => {});
  }

  async all(): Promise<OnchainBracket[]> {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    const out: OnchainBracket[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, entry), "utf8")) as OnchainBracket;
        if (parsed?.bracketId && parsed?.contractAddress) out.push(parsed);
      } catch {
        // skip corrupt/partial files
      }
    }
    return out;
  }
}
