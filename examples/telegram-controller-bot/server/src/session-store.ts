// Per-chat filesystem session storage. See ../../ARCHITECTURE.md "Session storage".
//
// Mirrors the shape that `controller/packages/controller/src/node/backend.ts`
// writes (signer + session + policies as separate keys), so stage 4 can
// reuse `controller/packages/controller/src/node/account.ts` to construct a
// signing Account. Namespaced by chatId so each Telegram user gets isolated
// session keys.

import { mkdir, readdir, readFile, rename, writeFile, unlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

import type { Chain } from "./chat-state.ts";
import { isChain } from "./chat-state.ts";

export interface SessionSigner {
  privKey: string;
  pubKey: string;
}

export interface SessionInfo {
  username: string;
  address: string;
  ownerGuid: string;
  expiresAt: string;        // unix seconds as string
  guardianKeyGuid: string;
  metadataHash: string;
  sessionKeyGuid: string;
  transactionHash?: string;
}

export interface StoredSession {
  signer: SessionSigner;
  session: SessionInfo;
  // ParsedSessionPolicies from @cartridge/controller — stored verbatim so
  // SessionProvider.probe() can validate the session was created with
  // a superset of the currently-required policies. Opaque to this module.
  policies: unknown;
  chain: Chain;
}

/**
 * Per-chat session storage namespaced by chain. A user can have one active
 * session per chain — switching chains via /chain doesn't erase the other.
 *
 * Path layout:
 *   <root>/sessions/<chain>/<chatId>/session.json
 */
export class SessionStore {
  constructor(private readonly rootDir: string) {}

  async get(chatId: string, chain: Chain): Promise<StoredSession | null> {
    const file = this.fileFor(chatId, chain);
    if (!existsSync(file)) return null;

    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return null;
    }

    let parsed: StoredSession;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (this.isExpired(parsed)) {
      await this.delete(chatId, chain).catch(() => {});
      return null;
    }
    return parsed;
  }

  async set(chatId: string, data: StoredSession): Promise<void> {
    const file = this.fileFor(chatId, data.chain);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, file);
  }

  async delete(chatId: string, chain: Chain): Promise<void> {
    const file = this.fileFor(chatId, chain);
    if (existsSync(file)) {
      await unlink(file).catch(() => {});
    }
    const dir = dirname(file);
    if (existsSync(dir)) {
      await rm(dir, { recursive: false }).catch(() => {});
    }
  }

  isExpired(session: StoredSession): boolean {
    const expiresAt = Number(session.session.expiresAt);
    if (!Number.isFinite(expiresAt)) return true;
    return Date.now() >= expiresAt * 1000;
  }

  /**
   * One-shot migration from the pre-chain-namespaced layout
   * (`<root>/sessions/<chatId>/session.json`) to the chain-namespaced layout.
   *
   * Reads each legacy session.json, uses its embedded `chain` field as the
   * destination subdirectory, moves the file. Idempotent — silently skips
   * if the target already exists.
   *
   * Should be called once on bot startup before any session reads.
   */
  async migrateLegacyLayout(defaultChain: Chain): Promise<{ migrated: number; skipped: number }> {
    const legacyRoot = join(this.rootDir, "sessions");
    if (!existsSync(legacyRoot)) return { migrated: 0, skipped: 0 };

    let migrated = 0;
    let skipped = 0;

    let entries: string[];
    try {
      entries = await readdir(legacyRoot);
    } catch {
      return { migrated: 0, skipped: 0 };
    }

    for (const entry of entries) {
      // Skip the chain directories themselves — already in the new layout.
      if (isChain(entry)) continue;
      // chatIds are integers (possibly negative). Anything else is foreign.
      if (!/^-?\d+$/.test(entry)) continue;

      const legacyFile = join(legacyRoot, entry, "session.json");
      if (!existsSync(legacyFile)) continue;

      let parsed: StoredSession | null = null;
      try {
        const raw = await readFile(legacyFile, "utf8");
        parsed = JSON.parse(raw) as StoredSession;
      } catch {
        skipped++;
        continue;
      }

      const chain = parsed?.chain && isChain(parsed.chain) ? parsed.chain : defaultChain;
      const targetFile = this.fileFor(entry, chain);

      if (existsSync(targetFile)) {
        skipped++;
        continue;
      }

      try {
        await mkdir(dirname(targetFile), { recursive: true });
        await rename(legacyFile, targetFile);
        // Best-effort cleanup of the now-empty legacy <chatId>/ dir.
        await rm(join(legacyRoot, entry), { recursive: false }).catch(() => {});
        migrated++;
      } catch {
        skipped++;
      }
    }

    return { migrated, skipped };
  }

  private fileFor(chatId: string, chain: Chain): string {
    if (!/^-?\d+$/.test(chatId)) {
      throw new Error(`Invalid chatId for session storage: ${chatId}`);
    }
    return join(this.rootDir, "sessions", chain, chatId, "session.json");
  }
}
