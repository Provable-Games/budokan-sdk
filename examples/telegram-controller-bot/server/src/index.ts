// Bootstrap. Wires HTTP server + Telegram long-poll, hooks shutdown, runs.
//
// See ../../ARCHITECTURE.md for the design overview. Each module has its own
// header comment with a pointer to the relevant section.

import { loadConfig } from "./config.ts";
import { ChatStateStore } from "./chat-state.ts";
import { HandshakeStore } from "./handshake.ts";
import { SessionStore } from "./session-store.ts";
import { buildHttpServer } from "./http.ts";
import { TelegramBot } from "./telegram.ts";

async function main() {
  const config = loadConfig();
  const handshakes = new HandshakeStore();
  const sessions = new SessionStore(config.dataDir);
  const chatStates = new ChatStateStore(config.dataDir, config.chain);

  // One-shot migration from the pre-chain-namespaced session layout.
  // Idempotent on subsequent boots.
  const migration = await sessions.migrateLegacyLayout(config.chain);
  if (migration.migrated > 0 || migration.skipped > 0) {
    console.log(
      `Session migration: ${migration.migrated} moved into <chain>/, ${migration.skipped} skipped (already present or unreadable).`,
    );
  }

  const bot = new TelegramBot(config, handshakes, sessions, chatStates);
  const http = await buildHttpServer({
    config,
    handshakes,
    sessions,
    telegram: bot.telegram,
  });

  handshakes.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    bot.shutdown();
    handshakes.stop();
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
  console.log(`MINIAPP_URL=${config.miniAppUrl}`);
  console.log(`Default chain: ${config.chain} (per-chat overrides via /chain)`);

  // Telegram long-poll runs until shutdown(); main() resolves only on exit.
  await bot.start();
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
