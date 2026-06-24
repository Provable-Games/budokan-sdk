// One-shot smoke test for the HTTP routes. Wires real modules with a mock
// Telegram client (no outbound calls), starts the server on a free port,
// runs through the connect handshake locally, and exits 0 on success.
//
// Run with: bun src/__smoke__.ts
//
// This file is not part of the production bundle; it exists to verify the
// stage 2 wiring works without needing a real Telegram bot or Mini App.

import { HandshakeStore } from "./handshake.ts";
import { SessionStore } from "./session-store.ts";
import { buildHttpServer } from "./http.ts";
import type { TelegramApi } from "./telegram-api.ts";
import type { Config } from "./config.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class FakeTelegramApi {
  public sent: Array<{ chatId: string; text: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendMessage(chatId: string, text: string, _options?: unknown): Promise<void> {
    this.sent.push({ chatId, text });
  }
  async call(): Promise<unknown> {
    return undefined;
  }
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), "telegram-bot-smoke-"));

  const config: Config = {
    telegramBotToken: "00000000:fake",
    chain: "mainnet",
    botPublicUrl: "http://localhost:0",
    httpPort: 0,
    dataDir,
  };
  const handshakes = new HandshakeStore();
  const sessions = new SessionStore(dataDir);
  const fakeTelegram = new FakeTelegramApi();
  const app = await buildHttpServer({
    config,
    handshakes,
    sessions,
    telegram: fakeTelegram as unknown as TelegramApi,
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let pass = 0;
  let fail = 0;
  async function check(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      fail++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await check("GET /healthz returns ok", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json() as { ok: boolean; chain: string };
    if (body.ok !== true || body.chain !== "mainnet") throw new Error(`bad body: ${JSON.stringify(body)}`);
  });

  await check("GET /api/connect/<unknown> returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/connect/00000000-0000-0000-0000-000000000000`);
    if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
  });

  let mintedToken: string;
  await check("Mint connect token + GET returns policies", async () => {
    const handshake = handshakes.mint("123456", "connect", "mainnet");
    mintedToken = handshake.token;
    const res = await fetch(`${baseUrl}/api/connect/${handshake.token}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json() as { chain: string; policies: { contracts: Record<string, unknown> }; status: string };
    if (body.chain !== "mainnet") throw new Error("wrong chain");
    if (body.status !== "pending") throw new Error("wrong status");
    const contracts = Object.keys(body.policies.contracts);
    if (contracts.length === 0) throw new Error("no contracts in policies");
  });

  await check("POST /api/connect/<token> with bad body returns 400", async () => {
    const handshake = handshakes.mint("999999", "connect", "mainnet");
    const res = await fetch(`${baseUrl}/api/connect/${handshake.token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  });

  await check("POST /api/connect/<token> persists session, fires chat notify", async () => {
    const expiresAt = String(Math.floor(Date.now() / 1000) + 3600);
    const sessionBody = {
      address: "0xABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      username: "smokeuser",
      ownerGuid: "0xDEADBEEF",
      expiresAt,
      sessionKeyGuid: "0xCAFEBABE",
      signer: { privKey: "0x1", pubKey: "0x2" },
    };
    const res = await fetch(`${baseUrl}/api/connect/${mintedToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionBody),
    });
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const body = await res.json() as { ok: boolean };
    if (!body.ok) throw new Error("not ok");

    // Persisted to filesystem
    const stored = await sessions.get("123456", "mainnet");
    if (!stored) throw new Error("session not persisted");
    if (stored.session.username !== "smokeuser") throw new Error("wrong username persisted");

    // Chat notification fired (best-effort, async — give it a tick)
    await new Promise((r) => setTimeout(r, 20));
    if (fakeTelegram.sent.length === 0) throw new Error("no chat notify");
    if (fakeTelegram.sent[0]?.chatId !== "123456") throw new Error("notify went to wrong chat");
  });

  await check("Token is single-use", async () => {
    const res = await fetch(`${baseUrl}/api/connect/${mintedToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.status !== 404) throw new Error(`expected 404 on reuse, got ${res.status}`);
  });

  await check("Session deletion clears the file", async () => {
    await sessions.delete("123456", "mainnet");
    const after = await sessions.get("123456", "mainnet");
    if (after !== null) throw new Error("session still present");
  });

  // --- Slot-pattern callback ---

  await check("GET /api/connect/<unknown>/callback returns 404 HTML", async () => {
    const res = await fetch(`${baseUrl}/api/connect/00000000-0000-0000-0000-000000000000/callback`);
    if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
    const text = await res.text();
    if (!text.includes("Authorization link expired")) throw new Error("missing expected error html");
  });

  await check("Callback without startapp returns 400 HTML", async () => {
    const handshake = handshakes.mint("777777", "connect", "mainnet", {
      signer: { privKey: "0xaa", pubKey: "0xbb", sessionKeyGuid: "0xcc" },
    });
    const res = await fetch(`${baseUrl}/api/connect/${handshake.token}/callback`);
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    const text = await res.text();
    if (!text.includes("Authorization missing")) throw new Error("missing expected error html");
  });

  await check("Callback with malformed startapp returns 400 HTML", async () => {
    const handshake = handshakes.mint("888888", "connect", "mainnet", {
      signer: { privKey: "0xaa", pubKey: "0xbb", sessionKeyGuid: "0xcc" },
    });
    const res = await fetch(`${baseUrl}/api/connect/${handshake.token}/callback?startapp=not-base64-json`);
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
    const text = await res.text();
    if (!text.includes("Authorization malformed")) throw new Error("missing expected error html");
  });

  await check("Callback with valid startapp persists session, fires chat notify", async () => {
    const handshake = handshakes.mint("555555", "connect", "mainnet", {
      signer: { privKey: "0xaaaa", pubKey: "0xbbbb", sessionKeyGuid: "0xcccc" },
    });
    const sessionPayload = {
      username: "slotuser",
      address: "0x" + "1".repeat(64),
      ownerGuid: "0x" + "2".repeat(40),
      expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
    };
    const startapp = Buffer.from(JSON.stringify(sessionPayload)).toString("base64");

    fakeTelegram.sent = [];
    const res = await fetch(`${baseUrl}/api/connect/${handshake.token}/callback?startapp=${encodeURIComponent(startapp)}`);
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const text = await res.text();
    if (!text.includes("Connected as slotuser")) throw new Error("missing success html");

    const stored = await sessions.get("555555", "mainnet");
    if (!stored) throw new Error("session not persisted");
    if (stored.session.username !== "slotuser") throw new Error("wrong username");
    if (stored.signer.privKey !== "0xaaaa") throw new Error("privKey not preserved from handshake");
    if (stored.session.sessionKeyGuid !== "0xcccc") throw new Error("sessionKeyGuid fallback wrong");

    await new Promise((r) => setTimeout(r, 20));
    if (fakeTelegram.sent.length === 0) throw new Error("no chat notify");
    if (fakeTelegram.sent[0]?.chatId !== "555555") throw new Error("notify went to wrong chat");
  });

  // --- Per-chat chain + storage namespacing ---

  await check("Legacy session layout migrates into <chain>/", async () => {
    // Set up a fresh tmpdir + SessionStore so the migration is observable
    // without colliding with what the smoke already created.
    const legacyDir = await mkdtemp(join(tmpdir(), "telegram-bot-legacy-"));
    try {
      const legacySessionFile = join(legacyDir, "sessions", "111111", "session.json");
      await mkdir(join(legacyDir, "sessions", "111111"), { recursive: true });
      await writeFile(legacySessionFile, JSON.stringify({
        signer: { privKey: "0x1", pubKey: "0x2" },
        session: {
          username: "legacy",
          address: "0x" + "a".repeat(64),
          ownerGuid: "0x" + "b".repeat(40),
          expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
          guardianKeyGuid: "0x0",
          metadataHash: "0x0",
          sessionKeyGuid: "0xc",
        },
        policies: { verified: false, contracts: {} },
        chain: "mainnet",
      }));

      const store = new SessionStore(legacyDir);
      const result = await store.migrateLegacyLayout("mainnet");
      if (result.migrated !== 1) throw new Error(`expected 1 migrated, got ${result.migrated}`);

      // Old path is gone, new path has the file.
      if (existsSync(legacySessionFile)) throw new Error("legacy file not removed");
      const newFile = join(legacyDir, "sessions", "mainnet", "111111", "session.json");
      if (!existsSync(newFile)) throw new Error("new file not present");

      // Re-running is idempotent (no double-migrate).
      const second = await store.migrateLegacyLayout("mainnet");
      if (second.migrated !== 0) throw new Error(`re-run migrated again: ${second.migrated}`);

      // SessionStore.get reads from the new path now.
      const after = await store.get("111111", "mainnet");
      if (!after || after.session.username !== "legacy") throw new Error("post-migration get failed");
    } finally {
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  await check("Sessions are isolated per chain for the same chat", async () => {
    const expiresAt = String(Math.floor(Date.now() / 1000) + 3600);
    const baseSession = {
      address: "0x" + "f".repeat(64),
      ownerGuid: "0x" + "e".repeat(40),
      expiresAt,
      sessionKeyGuid: "0xdead",
      signer: { privKey: "0x9", pubKey: "0x10" },
    };

    const mainnetHs = handshakes.mint("424242", "connect", "mainnet", {
      signer: { privKey: "0x9", pubKey: "0x10", sessionKeyGuid: "0xdead" },
    });
    const sepoliaHs = handshakes.mint("424242", "connect", "sepolia", {
      signer: { privKey: "0x9", pubKey: "0x10", sessionKeyGuid: "0xdead" },
    });

    // Use the callback path for both — that's the production path.
    const mainnetPayload = Buffer.from(JSON.stringify({ ...baseSession, username: "main_user" })).toString("base64");
    const sepoliaPayload = Buffer.from(JSON.stringify({ ...baseSession, username: "sepolia_user" })).toString("base64");

    const r1 = await fetch(`${baseUrl}/api/connect/${mainnetHs.token}/callback?startapp=${encodeURIComponent(mainnetPayload)}`);
    if (!r1.ok) throw new Error(`mainnet callback ${r1.status}`);
    const r2 = await fetch(`${baseUrl}/api/connect/${sepoliaHs.token}/callback?startapp=${encodeURIComponent(sepoliaPayload)}`);
    if (!r2.ok) throw new Error(`sepolia callback ${r2.status}`);

    const main = await sessions.get("424242", "mainnet");
    const sep = await sessions.get("424242", "sepolia");
    if (!main || main.session.username !== "main_user") throw new Error("mainnet session missing or wrong");
    if (!sep || sep.session.username !== "sepolia_user") throw new Error("sepolia session missing or wrong");
    if (main.chain !== "mainnet" || sep.chain !== "sepolia") throw new Error("chain field mis-set");
  });

  await app.close();
  await rm(dataDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
