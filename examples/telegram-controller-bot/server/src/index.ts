// Bootstrap. Wires HTTP server + Telegram long-poll, hooks shutdown, runs.
//
// See ../../ARCHITECTURE.md for the design overview. Each module has its own
// header comment with a pointer to the relevant section.

import { loadConfig } from "./config.ts";
import { ChatStateStore } from "./chat-state.ts";
import { HandshakeStore } from "./handshake.ts";
import { SessionStore } from "./session-store.ts";
import { BracketStore } from "./bracket-store.ts";
import { buildHttpServer } from "./http.ts";
import { TelegramBot } from "./telegram.ts";

// How often to advance running brackets (resolve matches, enter winners).
const BRACKET_TICK_MS = 60_000;

async function main() {
  const config = loadConfig();
  const handshakes = new HandshakeStore();
  const sessions = new SessionStore(config.dataDir);
  const chatStates = new ChatStateStore(config.dataDir, config.chain);
  const brackets = new BracketStore(config.dataDir);

  // One-shot migration from the pre-chain-namespaced session layout.
  // Idempotent on subsequent boots.
  const migration = await sessions.migrateLegacyLayout(config.chain);
  if (migration.migrated > 0 || migration.skipped > 0) {
    console.log(
      `Session migration: ${migration.migrated} moved into <chain>/, ${migration.skipped} skipped (already present or unreadable).`,
    );
  }

  const bot = new TelegramBot(config, handshakes, sessions, chatStates, brackets);
  const http = await buildHttpServer({
    config,
    handshakes,
    sessions,
    telegram: bot.telegram,
  });

  handshakes.start();

  // Advance running brackets on an interval (resolve matches, enter winners,
  // post updates). unref so it never holds the process open on its own.
  const bracketTimer = setInterval(() => void bot.bracketTick(), BRACKET_TICK_MS);
  bracketTimer.unref?.();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    bot.shutdown();
    handshakes.stop();
    clearInterval(bracketTimer);
    try {
      await http.close();
    } catch (error) {
      console.error("HTTP close failed:", error);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await http.listen({ host: "0.0.0.0", port: config.httpPort });
  console.log(`HTTP listening on :${config.httpPort}`);
  console.log(`BOT_PUBLIC_URL=${config.botPublicUrl}`);
  console.log(`Default chain: ${config.chain} (per-chat overrides via /chain)`);

  // Telegram long-poll runs until shutdown(); main() resolves only on exit.
  await bot.start();
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
