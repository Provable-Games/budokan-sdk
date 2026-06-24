// Fastify HTTP server for the Cartridge slot-pattern auth callback. See
// ../../ARCHITECTURE.md "Auth handshake protocol".
//
// Routes:
//   GET  /healthz                          — liveness probe
//   GET  /api/connect/:token/callback      — Cartridge redirects the user's
//                                            browser here after they authorize

import Fastify, { type FastifyInstance } from "fastify";

import type { Config } from "./config.ts";
import type { HandshakeStore } from "./handshake.ts";
import type { SessionStore, StoredSession } from "./session-store.ts";
import { parsedPoliciesFor } from "./policies.ts";
import type { TelegramApi } from "./telegram-api.ts";
import { decodeStartapp } from "./cartridge-link.ts";

interface BuildOptions {
  config: Config;
  handshakes: HandshakeStore;
  sessions: SessionStore;
  telegram: TelegramApi;
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
    // The /connect callback carries the connect token in the path and the
    // session registration in `?startapp=`. Fastify's automatic per-request
    // logging would write those URLs to stdout/Railway logs — disable it so
    // auth material never lands in logs. We still log explicitly via app.log.
    disableRequestLogging: true,
  });

  app.get("/healthz", async () => ({ ok: true, chain: config.chain }));

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

function shortAddress(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}
