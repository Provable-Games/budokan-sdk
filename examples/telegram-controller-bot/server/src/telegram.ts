// Telegram long-poll loop and command dispatch. See ../../ARCHITECTURE.md
// "Auth handshake protocol".
//
// Stage 2 commands: /start, /help, /connect, /disconnect, /whoami.
// Stages 3-5 add: /claim, /create, /enter, plus read-only /follow etc.

import type { Config } from "./config.ts";
import type { HandshakeStore } from "./handshake.ts";
import type { SessionStore } from "./session-store.ts";
import { TelegramApi, webAppButton } from "./telegram-api.ts";

interface TelegramMessage {
  chat: { id: number };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramBot {
  private readonly api: TelegramApi;
  private readonly abort = new AbortController();
  private stopping = false;

  constructor(
    private readonly config: Config,
    private readonly handshakes: HandshakeStore,
    private readonly sessions: SessionStore,
  ) {
    this.api = new TelegramApi(config.telegramBotToken);
  }

  /** Reused by the HTTP server to push notifications back to the chat. */
  get telegram(): TelegramApi {
    return this.api;
  }

  async start(): Promise<void> {
    // getUpdates conflicts with a configured webhook; clear in case one is set.
    await this.api.call("deleteWebhook", { drop_pending_updates: false });
    await this.poll();
  }

  shutdown(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.abort.abort();
  }

  private async poll(): Promise<void> {
    let offset: number | undefined;
    while (!this.stopping) {
      try {
        const updates = await this.api.call<TelegramUpdate[]>(
          "getUpdates",
          { timeout: 50, offset, allowed_updates: ["message"] },
          { signal: this.abort.signal },
        );
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message?.text) {
            await this.handleMessage(update.message).catch((error) => {
              console.error("Command handler failed:", formatError(error));
              this.api
                .sendMessage(String(update.message!.chat.id), `Sorry, that command failed: ${formatError(error)}`)
                .catch((err) => console.error("Failed to notify user of error:", formatError(err)));
            });
          }
        }
      } catch (error) {
        if (this.stopping || isAbortError(error)) break;
        console.error("Telegram polling failed:", formatError(error));
        await sleep(2000, this.abort.signal);
      }
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const text = (message.text ?? "").trim();
    const [rawCommand, ..._args] = text.split(/\s+/);
    const command = (rawCommand ?? "").split("@")[0]?.toLowerCase();

    switch (command) {
      case "/start":
      case "/help":
        return this.sendHelp(chatId);
      case "/connect":
        return this.connect(chatId);
      case "/disconnect":
        return this.disconnect(chatId);
      case "/whoami":
        return this.whoami(chatId);
      default:
        // Silently ignore unknown commands. Stages 3-5 add more commands;
        // unrecognized text remains a no-op so the bot doesn't spam users.
        return;
    }
  }

  private async sendHelp(chatId: string): Promise<void> {
    await this.api.sendMessage(
      chatId,
      [
        `Budokan Telegram bot (chain: ${this.config.chain})`,
        "",
        "/connect — authorize the bot via Cartridge in a Telegram Mini App",
        "/disconnect — clear your stored session",
        "/whoami — show the connected account",
        "",
        "Signed actions (/claim, /create, /enter) land in upcoming stages.",
      ].join("\n"),
    );
  }

  private async connect(chatId: string): Promise<void> {
    const existing = await this.sessions.get(chatId);
    if (existing) {
      await this.api.sendMessage(
        chatId,
        `Already connected as ${existing.session.username}. Use /disconnect first to start over.`,
      );
      return;
    }

    const handshake = this.handshakes.mint(chatId, "connect");
    const url = this.miniAppUrl(handshake.token, "connect");
    await this.api.sendMessage(
      chatId,
      "Tap the button below to authorize the bot. Sign in with Cartridge and approve the session policies. The window will close automatically when done.",
      { replyMarkup: webAppButton("Open authorization", url) },
    );
  }

  private async disconnect(chatId: string): Promise<void> {
    const existing = await this.sessions.get(chatId);
    if (!existing) {
      await this.api.sendMessage(chatId, "No session to disconnect.");
      return;
    }
    await this.sessions.delete(chatId);
    await this.api.sendMessage(chatId, `Disconnected ${existing.session.username}. Run /connect to authorize again.`);
  }

  private async whoami(chatId: string): Promise<void> {
    const session = await this.sessions.get(chatId);
    if (!session) {
      await this.api.sendMessage(chatId, "Not connected. Run /connect to authorize.");
      return;
    }
    const expiresAt = new Date(Number(session.session.expiresAt) * 1000);
    await this.api.sendMessage(
      chatId,
      [
        `Username: ${session.session.username}`,
        `Address: ${session.session.address}`,
        `Chain: ${session.chain}`,
        `Session expires: ${expiresAt.toISOString()}`,
      ].join("\n"),
    );
  }

  private miniAppUrl(token: string, mode: "connect" | "tx"): string {
    const base = this.config.miniAppUrl;
    return `${base}/?token=${encodeURIComponent(token)}&mode=${mode}`;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cleanup);
      resolve();
    };
    const timeout = setTimeout(cleanup, ms);
    signal?.addEventListener("abort", cleanup, { once: true });
  });
}
