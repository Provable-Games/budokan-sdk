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

import { CHAINS } from "@provable-games/budokan-sdk";

import type { Config } from "./config.ts";
import type { HandshakeStore } from "./handshake.ts";
import type { SessionStore, StoredSession } from "./session-store.ts";
import { buildSessionPolicies, parsedPoliciesFor } from "./policies.ts";
import type { TelegramApi } from "./telegram-api.ts";

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
    const rpcUrl = config.rpcUrl ?? CHAINS[config.chain]?.rpcUrl;
    if (!rpcUrl) {
      reply.code(500);
      return { error: `No RPC URL configured for chain '${config.chain}'.` };
    }
    return {
      chain: config.chain,
      rpcUrl,
      policies: buildSessionPolicies(config.chain, config.budokanAddress),
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
      stored = parseSessionBody(req.body, config.chain);
      // Persist the policy bundle (in ParsedSessionPolicies shape)
      // alongside signer/session. SessionProvider.probe() uses it to
      // validate the session was created with a superset of the
      // currently-required policies. Server-side derivation: we know
      // exactly which bundle the Mini App was given (deterministic
      // function of chain), so trust it from policies.ts rather than
      // accepting it from the client.
      stored.policies = parsedPoliciesFor(config.chain, config.budokanAddress);
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

  return app;
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
