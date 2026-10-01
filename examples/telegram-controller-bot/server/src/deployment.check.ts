import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStateStore } from "./chat-state.ts";

// Exercise startup validation in child processes because loadConfig exits on
// missing settings. Fake values only; no Telegram or chain calls are made.
const configured: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "test", BOT_PUBLIC_URL: "http://localhost",
  BUDOKAN_ADDRESS: "0x1234", BUDOKAN_VIEWER_ADDRESS: "0x5678",
  BUDOKAN_API_URL: "https://example.invalid",
};
const args = [process.execPath, "-e", 'import { loadConfig } from "./src/config.ts"; loadConfig();'];
assert.equal(Bun.spawnSync(args, { env: configured }).exitCode, 0);
for (const name of ["BUDOKAN_ADDRESS", "BUDOKAN_VIEWER_ADDRESS", "BUDOKAN_API_URL"]) {
  const env = { ...configured };
  delete env[name];
  const result = Bun.spawnSync(args, { env });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr.toString(), new RegExp(`${name} is required`));
}
console.log("Bot startup requires a complete GameCore deployment configuration");
const wsArgs = [process.execPath, "-e", 'import { loadConfig } from "./src/config.ts"; console.log(loadConfig().wsUrl);'];
for (const [apiUrl, expected] of [
  ["https://example.invalid/", "wss://example.invalid/ws"],
  ["http://localhost:8080", "ws://localhost:8080/ws"],
]) {
  const result = Bun.spawnSync(wsArgs, { env: { ...configured, BUDOKAN_API_URL: apiUrl! } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString().trim(), expected);
}
const customWs = Bun.spawnSync(wsArgs, { env: { ...configured, BUDOKAN_WS_URL: "wss://events.invalid/ws" } });
assert.equal(customWs.exitCode, 0);
assert.equal(customWs.stdout.toString().trim(), "wss://events.invalid/ws");
console.log("WebSocket notifications use the configured API deployment or explicit override");


const dataDir = await mkdtemp(join(tmpdir(), "bot-chain-check-"));
try {
  await mkdir(join(dataDir, "chats", "123"), { recursive: true });
  await writeFile(join(dataDir, "chats", "123", "state.json"), JSON.stringify({ chain: "mainnet" }));
  const store = new ChatStateStore(dataDir, "sepolia");
  assert.equal(await store.getChain("123"), "sepolia");
  await assert.rejects(() => store.setChain("123", "mainnet"), /configured for sepolia/);
  await store.setChain("123", "sepolia");
  assert.equal(await store.getChain("123"), "sepolia");
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
console.log("Persisted preferences and chain switches cannot override the deployment chain");
