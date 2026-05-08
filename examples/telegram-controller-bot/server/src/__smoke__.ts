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
import { mkdtemp, rm } from "node:fs/promises";
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
    miniAppUrl: "http://localhost:5173",
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
    const handshake = handshakes.mint("123456", "connect");
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
    const handshake = handshakes.mint("999999", "connect");
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
    const stored = await sessions.get("123456");
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
    await sessions.delete("123456");
    const after = await sessions.get("123456");
    if (after !== null) throw new Error("session still present");
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
