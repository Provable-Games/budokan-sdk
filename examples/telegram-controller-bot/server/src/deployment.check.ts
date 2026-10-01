import assert from "node:assert/strict";

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
