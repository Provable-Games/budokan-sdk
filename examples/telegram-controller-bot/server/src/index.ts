// Bootstrap. Wires HTTP server + Telegram long-poll, hooks shutdown, runs.
//
// See ../../ARCHITECTURE.md for the design overview. Each module has its own
// header comment with a pointer to the relevant section.

import { loadConfig } from "./config.ts";
import { HandshakeStore } from "./handshake.ts";
import { SessionStore } from "./session-store.ts";
import { buildHttpServer } from "./http.ts";
import { TelegramBot } from "./telegram.ts";

async function main() {
  const config = loadConfig();
  const handshakes = new HandshakeStore();
  const sessions = new SessionStore(config.dataDir);

  const bot = new TelegramBot(config, handshakes, sessions);
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
  console.log(`Chain: ${config.chain}`);

  // Telegram long-poll runs until shutdown(); main() resolves only on exit.
  await bot.start();
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
