// One-time handshake tokens with TTL. See ../../ARCHITECTURE.md "Auth handshake protocol".
//
// In-memory only — bouncing the bot resets all in-flight handshakes, which is
// fine: a user just runs /connect again. The 5-minute TTL matches the
// callback-server timeout in the upstream Cartridge Node example.

import { randomUUID } from "node:crypto";

import type { Chain } from "./chat-state.ts";

export type HandshakeMode = "connect";

export interface HandshakeToken {
  token: string;
  chatId: string;
  mode: HandshakeMode;
  /**
   * Chain at the moment the token was minted. Carried on the token so a
   * /chain switch mid-flow doesn't redirect the auth into a different
   * namespace than where the user thought they were connecting.
   */
  chain: Chain;
  /** Unix ms */
  expiresAt: number;
  /**
   * mode === "connect": ephemeral session keypair + sessionKeyGuid the bot
   * generated when the token was minted. Cartridge signs an authorization
   * for `pubKey`; combined with `privKey` and the redirect-returned session
   * registration, this is what the bot needs to sign on the user's behalf.
   */
  signer?: { privKey: string; pubKey: string; sessionKeyGuid: string };
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class HandshakeStore {
  private readonly tokens = new Map<string, HandshakeToken>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  start(): void {
    if (this.cleanupTimer) return;
    // Sweep expired tokens once a minute.
    this.cleanupTimer = setInterval(() => this.sweep(), 60_000);
    // Don't keep the process alive just for cleanup.
    this.cleanupTimer.unref?.();
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  mint(
    chatId: string,
    mode: HandshakeMode,
    chain: Chain,
    options: { signer?: HandshakeToken["signer"] } = {},
  ): HandshakeToken {
    const token = randomUUID();
    const handshake: HandshakeToken = {
      token,
      chatId,
      mode,
      chain,
      expiresAt: Date.now() + this.ttlMs,
      signer: options.signer,
    };
    this.tokens.set(token, handshake);
    return handshake;
  }

  /** Look up a token without consuming it. Returns null if missing or expired. */
  peek(token: string): HandshakeToken | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.tokens.delete(token);
      return null;
    }
    return entry;
  }

  /** Look up and remove a token in one shot. Single-use semantics. */
  consume(token: string): HandshakeToken | null {
    const entry = this.peek(token);
    if (entry) this.tokens.delete(token);
    return entry;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (now >= entry.expiresAt) this.tokens.delete(token);
    }
  }
}
