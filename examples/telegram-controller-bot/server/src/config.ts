// Env-var loading and validation. See ../../ARCHITECTURE.md "Configuration".
//
// Required vars exit on missing; optional vars resolve to documented defaults.

import { resolve } from "node:path";

export interface Config {
  telegramBotToken: string;
  chain: "mainnet" | "sepolia";
  botPublicUrl: string;     // public HTTPS base URL for the Cartridge auth callback
  httpPort: number;
  dataDir: string;          // filesystem root for session storage
  apiUrl?: string;
  wsUrl?: string;
  rpcUrl?: string;
  budokanAddress?: string;
  viewerAddress?: string;
  /** Optional. Voyager API proxy used to fetch user token balances for
   *  prize-sponsorship pickers. If unset, prize sponsorship at /create
   *  time is disabled and the bot tells the user to add prizes via budokan.gg. */
  voyagerProxyUrl?: string;
  /** Optional. Bearer token required by the proxy for server-to-server
   *  callers. Must match one of the comma-separated tokens in the proxy's
   *  PROXY_AUTH_TOKENS env var. */
  voyagerProxyToken?: string;
  /** Optional public chat id for bracket announcements; falls back to DM. */
  bracketChannelId?: string;
}

export function loadConfig(): Config {
  const telegramBotToken = required("TELEGRAM_BOT_TOKEN");

  const chain = (env("BUDOKAN_CHAIN") ?? "mainnet") as Config["chain"];
  if (chain !== "mainnet" && chain !== "sepolia") {
    fail("BUDOKAN_CHAIN must be 'mainnet' or 'sepolia'.");
  }

  const botPublicUrl = required("BOT_PUBLIC_URL").replace(/\/$/, "");
  if (!/^https?:\/\//.test(botPublicUrl)) {
    fail("BOT_PUBLIC_URL must include scheme (https:// or http://).");
  }
  // Cartridge redirects the user's browser to
  // BOT_PUBLIC_URL/api/connect/:token/callback after they authorize, so HTTPS
  // is required in production (localhost is fine for dev).
  if (!botPublicUrl.startsWith("https://") && !botPublicUrl.includes("localhost") && !botPublicUrl.includes("127.0.0.1")) {
    console.warn("Warning: BOT_PUBLIC_URL is not HTTPS. The Cartridge auth callback will fail except on localhost.");
  }

  // Railway and most PaaS hosts inject PORT. Honor it first; BOT_HTTP_PORT
  // is the local-dev fallback.
  const httpPortRaw = env("PORT") ?? env("BOT_HTTP_PORT") ?? "8787";
  const httpPort = Number(httpPortRaw);
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    fail(`PORT/BOT_HTTP_PORT must be a valid port number, got: ${httpPortRaw}`);
  }

  const dataDir = resolve(env("BOT_DATA_DIR") ?? "./data");

  return {
    telegramBotToken,
    chain,
    botPublicUrl,
    httpPort,
    dataDir,
    apiUrl: env("BUDOKAN_API_URL"),
    wsUrl: env("BUDOKAN_WS_URL"),
    rpcUrl: env("BUDOKAN_RPC_URL"),
    budokanAddress: env("BUDOKAN_ADDRESS"),
    viewerAddress: env("BUDOKAN_VIEWER_ADDRESS"),
    voyagerProxyUrl: env("BUDOKAN_VOYAGER_PROXY_URL"),
    voyagerProxyToken: env("BUDOKAN_VOYAGER_PROXY_TOKEN"),
    // Optional public chat (group/channel id) to post bracket trees + updates
    // to. Falls back to the organizer's DM when unset.
    bracketChannelId: env("BRACKET_CHANNEL_ID"),
  };
}

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function required(name: string): string {
  const value = env(name);
  if (!value) fail(`${name} is required.`);
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
