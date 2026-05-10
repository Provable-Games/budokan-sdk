// Fastify HTTP server. Mini App ↔ bot communication. See ../../ARCHITECTURE.md
// "Auth handshake protocol".
//
// Routes (v1, stage 2):
//   GET  /healthz                         — liveness probe
//   GET  /api/connect/:token              — Mini App fetches policies + chain
//   POST /api/connect/:token              — Mini App posts session data back
//
// Tx handshake routes land in stage 5.

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";

import type { Config } from "./config.ts";
import type { Chain } from "./chat-state.ts";
import type { HandshakeStore } from "./handshake.ts";
import type { SessionStore, StoredSession } from "./session-store.ts";
import { parsedPoliciesFor } from "./policies.ts";
import type { TelegramApi } from "./telegram-api.ts";
import { decodeStartapp, keychainSafeRpcUrl } from "./cartridge-link.ts";

interface BuildOptions {
  config: Config;
  handshakes: HandshakeStore;
  sessions: SessionStore;
  telegram: TelegramApi;
}

interface SessionPostBody {
  address?: unknown;
  username?: unknown;
  ownerGuid?: unknown;
  expiresAt?: unknown;
  guardianKeyGuid?: unknown;
  metadataHash?: unknown;
  sessionKeyGuid?: unknown;
  signer?: { privKey?: unknown; pubKey?: unknown };
}

export async function buildHttpServer(opts: BuildOptions): Promise<FastifyInstance> {
  const { config, handshakes, sessions, telegram } = opts;

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport: process.stdout.isTTY
        ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } }
        : undefined,
    },
  });

  // Mini App is a different origin from the bot server. Keep CORS narrow:
  // only the Mini App URL, only the methods we use.
  await app.register(cors, {
    origin: [config.miniAppUrl],
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false,
  });

  app.get("/healthz", async () => ({ ok: true, chain: config.chain }));

  // Handshake: Mini App fetches the policy bundle for a connect token. The
  // token MUST be valid + unconsumed; we don't burn it on read so the
  // Mini App can retry on transient errors before final POST.
  app.get<{ Params: { token: string } }>("/api/connect/:token", async (req, reply) => {
    const handshake = handshakes.peek(req.params.token);
    if (!handshake || handshake.mode !== "connect") {
      reply.code(404);
      return { error: "Token invalid or expired." };
    }
    const chain = handshake.chain;
    let rpcUrl: string;
    try {
      rpcUrl = keychainSafeRpcUrl(chain, config.rpcUrl);
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : String(error) };
    }
    return {
      chain,
      rpcUrl,
      policies: parsedPoliciesFor(chain, config.budokanAddress),
      status: "pending",
    };
  });

  // Handshake: Mini App posts the resulting session data. We persist it
  // server-side keyed by the chatId encoded in the token, then nudge the
  // user in chat. Token is single-use.
  app.post<{ Params: { token: string }; Body: SessionPostBody }>("/api/connect/:token", async (req, reply) => {
    const handshake = handshakes.consume(req.params.token);
    if (!handshake || handshake.mode !== "connect") {
      reply.code(404);
      return { error: "Token invalid, expired, or already used." };
    }

    let stored: StoredSession;
    try {
      stored = parseSessionBody(req.body, handshake.chain);
      // Persist the policy bundle (in ParsedSessionPolicies shape)
      // alongside signer/session. SessionProvider.probe() uses it to
      // validate the session was created with a superset of the
      // currently-required policies. Server-side derivation tied to the
      // chain on the handshake — we know exactly which bundle the Mini
      // App was given (deterministic function of chain).
      stored.policies = parsedPoliciesFor(handshake.chain, config.budokanAddress);
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : "Invalid session body." };
    }

    await sessions.set(handshake.chatId, stored);

    // Best-effort chat notification. The Mini App's success state should not
    // depend on this — Telegram could be flaky and we already persisted.
    telegram
      .sendMessage(
        handshake.chatId,
        `Connected as ${stored.session.username} (${shortAddress(stored.session.address)}).\n` +
          "/whoami, /disconnect, and signed actions are now available.",
      )
      .catch((error: unknown) => {
        app.log.error({ err: error }, "Failed to send connect confirmation to chat");
      });

    return { ok: true };
  });

  // Slot-pattern callback. Cartridge redirects the user's browser here after
  // they authorize at https://x.cartridge.gg/session. The session registration
  // arrives as `?startapp=<base64-encoded JSON>`. We decode, combine with the
  // ephemeral keypair stashed in the handshake on /connect, and persist the
  // full session. Returns plain HTML so the user's tab shows a confirmation.
  app.get<{ Params: { token: string }; Querystring: { startapp?: string; error?: string } }>(
    "/api/connect/:token/callback",
    async (req, reply) => {
      const handshake = handshakes.consume(req.params.token);
      if (!handshake || handshake.mode !== "connect" || !handshake.signer) {
        reply.code(404).type("text/html");
        return errorHtml(
          "Authorization link expired",
          "This connect token is no longer valid. Run /connect again from Telegram.",
        );
      }

      // If Cartridge redirected with an error param instead of startapp,
      // surface it. Otherwise we expect startapp present.
      if (req.query.error) {
        reply.code(400).type("text/html");
        return errorHtml(
          "Authorization declined",
          `Cartridge reported: ${escapeHtml(req.query.error)}. Run /connect again to retry.`,
        );
      }
      if (!req.query.startapp) {
        reply.code(400).type("text/html");
        return errorHtml(
          "Authorization missing",
          "Cartridge didn't return a session. Run /connect again to retry.",
        );
      }

      const decoded = decodeStartapp(req.query.startapp);
      if (!decoded) {
        reply.code(400).type("text/html");
        return errorHtml(
          "Authorization malformed",
          "Cartridge sent something we couldn't parse. Run /connect again.",
        );
      }

      const stored: StoredSession = {
        signer: { privKey: handshake.signer.privKey, pubKey: handshake.signer.pubKey },
        session: {
          username: decoded.username,
          address: decoded.address,
          ownerGuid: decoded.ownerGuid,
          expiresAt: decoded.expiresAt,
          guardianKeyGuid: decoded.guardianKeyGuid ?? "0x0",
          metadataHash: decoded.metadataHash ?? "0x0",
          // Cartridge may not echo the sessionKeyGuid; fall back to the one
          // the bot computed locally when minting the keypair.
          sessionKeyGuid: decoded.sessionKeyGuid ?? handshake.signer.sessionKeyGuid,
          transactionHash: decoded.transactionHash,
        },
        policies: parsedPoliciesFor(handshake.chain, config.budokanAddress),
        chain: handshake.chain,
      };

      await sessions.set(handshake.chatId, stored);

      // Notify chat. Best-effort; the user already sees the success page.
      telegram
        .sendMessage(
          handshake.chatId,
          [
            `Connected as ${stored.session.username} (${shortAddress(stored.session.address)}).`,
            "/whoami, /disconnect, and signed actions are now available.",
          ].join("\n"),
        )
        .catch((error: unknown) => {
          app.log.error({ err: error }, "Failed to send connect confirmation to chat");
        });

      reply.type("text/html");
      return successHtml(stored.session.username);
    },
  );

  // --- Tx-mode handshake (paid /enter, future paid /create with prizes etc.) ---
  //
  // Bot mints a tx-mode token whose payload is { calls, summary } — the calls
  // the Mini App should ask the user to sign. The Mini App fetches the token,
  // displays the summary, runs Cartridge openExecute(), and POSTs the
  // resulting tx hash back. Bot relays to the chat.
  //
  // Token is consumed on POST. GET is non-consuming so the Mini App can fetch
  // payload on mount; the user needs the same token for both.

  app.get<{ Params: { token: string } }>("/api/tx/:token", async (req, reply) => {
    const handshake = handshakes.peek(req.params.token);
    if (!handshake || handshake.mode !== "tx" || !handshake.payload) {
      reply.code(404);
      return { error: "Tx token invalid or expired." };
    }
    const chain: Chain = handshake.chain;
    let rpcUrl: string;
    try {
      rpcUrl = keychainSafeRpcUrl(chain, config.rpcUrl);
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : String(error) };
    }
    return {
      chain,
      rpcUrl,
      calls: handshake.payload.calls,
      summary: handshake.payload.summary,
    };
  });

  app.post<{
    Params: { token: string };
    Body: { txHash?: unknown; error?: unknown };
  }>("/api/tx/:token", async (req, reply) => {
    const handshake = handshakes.consume(req.params.token);
    if (!handshake || handshake.mode !== "tx") {
      reply.code(404);
      return { error: "Tx token invalid, expired, or already used." };
    }

    if (typeof req.body?.error === "string") {
      // User cancelled or Cartridge returned an error.
      telegram
        .sendMessage(handshake.chatId, `Transaction cancelled: ${req.body.error}`)
        .catch((error: unknown) => app.log.error({ err: error }, "Failed chat notify"));
      return { ok: true };
    }

    if (typeof req.body?.txHash !== "string" || req.body.txHash.length === 0) {
      reply.code(400);
      return { error: "Body must include txHash (string)." };
    }
    const txHash = req.body.txHash;

    // Best-effort chat notify. We don't wait for inclusion here — the Mini App
    // already showed the user the tx hash, and the chat just gets confirmation.
    telegram
      .sendMessage(handshake.chatId, `Transaction submitted ✓\ntx: ${txHash}`)
      .catch((error: unknown) => app.log.error({ err: error }, "Failed chat notify"));

    return { ok: true };
  });

  return app;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function successHtml(username: string): string {
  const safe = escapeHtml(username);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connected</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;background:#0b0b0b;color:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}.card{max-width:420px;background:#181818;border-radius:16px;padding:32px;text-align:center}.ok{font-size:48px;line-height:1;margin-bottom:12px}h1{font-size:20px;margin:0 0 8px}p{opacity:.75;margin:8px 0}</style></head><body><div class="card"><div class="ok">✓</div><h1>Connected as ${safe}</h1><p>You can close this tab and return to Telegram.</p><p>Your bot will reply there to confirm.</p></div></body></html>`;
}

function errorHtml(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;background:#0b0b0b;color:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}.card{max-width:420px;background:#181818;border-radius:16px;padding:32px;text-align:center}.x{font-size:48px;line-height:1;margin-bottom:12px;color:#ff5d5d}h1{font-size:20px;margin:0 0 8px}p{opacity:.75;margin:8px 0}</style></head><body><div class="card"><div class="x">✗</div><h1>${escapeHtml(title)}</h1><p>${message}</p></div></body></html>`;
}

function parseSessionBody(body: SessionPostBody, chain: "mainnet" | "sepolia"): StoredSession {
  if (!body || typeof body !== "object") {
    throw new Error("Body must be a JSON object.");
  }
  const username = expectString(body.username, "username");
  const address = expectString(body.address, "address").toLowerCase();
  const ownerGuid = expectString(body.ownerGuid, "ownerGuid").toLowerCase();
  const expiresAt = expectString(body.expiresAt, "expiresAt");
  if (!/^\d+$/.test(expiresAt)) {
    throw new Error("expiresAt must be a unix-seconds integer string.");
  }
  const guardianKeyGuid = stringOr(body.guardianKeyGuid, "0x0");
  const metadataHash = stringOr(body.metadataHash, "0x0");
  const sessionKeyGuid = expectString(body.sessionKeyGuid, "sessionKeyGuid");
  if (!body.signer || typeof body.signer !== "object") {
    throw new Error("signer is required and must include privKey/pubKey.");
  }
  const privKey = expectString(body.signer.privKey, "signer.privKey");
  const pubKey = expectString(body.signer.pubKey, "signer.pubKey");

  return {
    signer: { privKey, pubKey },
    session: {
      username,
      address,
      ownerGuid,
      expiresAt,
      guardianKeyGuid,
      metadataHash,
      sessionKeyGuid,
    },
    // Filled in by the caller from the server-side policies module so we
    // don't trust the client to set its own policy scope.
    policies: undefined,
    chain,
  };
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required and must be a non-empty string.`);
  }
  return value;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function shortAddress(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}
