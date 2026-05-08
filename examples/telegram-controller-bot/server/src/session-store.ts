// Per-chat filesystem session storage. See ../../ARCHITECTURE.md "Session storage".
//
// Mirrors the shape that `controller/packages/controller/src/node/backend.ts`
// writes (signer + session + policies as separate keys), so stage 4 can
// reuse `controller/packages/controller/src/node/account.ts` to construct a
// signing Account. Namespaced by chatId so each Telegram user gets isolated
// session keys.

import { mkdir, readFile, rename, writeFile, unlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

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
  chain: "mainnet" | "sepolia";
}

export class SessionStore {
  constructor(private readonly rootDir: string) {}

  async get(chatId: string): Promise<StoredSession | null> {
    const file = this.fileFor(chatId);
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

    // Drop expired sessions on read so callers always see a usable session
    // or none — never something half-valid.
    if (this.isExpired(parsed)) {
      await this.delete(chatId).catch(() => {});
      return null;
    }
    return parsed;
  }

  async set(chatId: string, data: StoredSession): Promise<void> {
    const file = this.fileFor(chatId);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, file);
  }

  async delete(chatId: string): Promise<void> {
    const file = this.fileFor(chatId);
    if (existsSync(file)) {
      await unlink(file).catch(() => {});
    }
    // Best-effort directory cleanup if empty.
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

  private fileFor(chatId: string): string {
    // Reject path-traversal style chatIds. Telegram chat IDs are integers
    // (sometimes negative for groups), so this is mostly defensive.
    if (!/^-?\d+$/.test(chatId)) {
      throw new Error(`Invalid chatId for session storage: ${chatId}`);
    }
    return join(this.rootDir, "sessions", chatId, "session.json");
  }
}
