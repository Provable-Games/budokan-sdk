// Raw Telegram Bot API wrapper. Long-poll loop lives in telegram.ts; this
// module only knows how to call Telegram and chunk outgoing messages.

const TELEGRAM_CHUNK_LIMIT = 3900;

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

export interface SendMessageOptions {
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
  disableWebPagePreview?: boolean;
}

export class TelegramApi {
  constructor(private readonly botToken: string) {}

  private get baseUrl(): string {
    return `https://api.telegram.org/bot${this.botToken}`;
  }

  async call<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    const payload = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.description ?? `Telegram ${method} failed`);
    }
    return payload.result as T;
  }

  /**
   * Send a text message, splitting into multiple Telegram-safe chunks at line
   * boundaries when above the 4096-char API limit. The reply_markup (if any)
   * only attaches to the final chunk so the button isn't repeated.
   */
  async sendMessage(chatId: string, text: string, options: SendMessageOptions = {}): Promise<void> {
    const chunks = splitForTelegram(text);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: chunks[i],
        disable_web_page_preview: options.disableWebPagePreview ?? true,
      };
      if (isLast && options.replyMarkup) {
        body.reply_markup = options.replyMarkup;
      }
      await this.call("sendMessage", body);
    }
  }

  /**
   * Send a photo by URL with an optional caption — used to surface a game's
   * thumbnail above a leaderboard/detail view. Telegram fetches the image from
   * `photoUrl` itself, so no upload is needed.
   *
   * Best-effort and graceful: a caption above Telegram's 1024-char photo limit
   * is truncated, and any failure (dead image URL, unsupported format) is
   * swallowed so the caller can fall back to a plain text message. Returns
   * true when the photo was sent, false otherwise.
   */
  async sendPhoto(
    chatId: string,
    photoUrl: string,
    caption?: string,
  ): Promise<boolean> {
    if (!photoUrl) return false;
    const body: Record<string, unknown> = { chat_id: chatId, photo: photoUrl };
    if (caption) {
      // Telegram caps photo captions at 1024 chars (vs 4096 for messages).
      body.caption = caption.length > 1024 ? `${caption.slice(0, 1023)}…` : caption;
    }
    try {
      await this.call("sendPhoto", body);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Acknowledge an inline-button tap so Telegram stops showing the button's
   * loading spinner. Best-effort — a failed ack shouldn't abort the action
   * the button triggered.
   */
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    }).catch(() => {});
  }
}

export function splitForTelegram(text: string): string[] {
  if (typeof text !== "string" || text.length <= TELEGRAM_CHUNK_LIMIT) {
    return [text];
  }
  const lines = text.split("\n");
  const chunks: string[] = [];
  let buffer = "";
  for (const line of lines) {
    if (line.length > TELEGRAM_CHUNK_LIMIT) {
      if (buffer) {
        chunks.push(buffer);
        buffer = "";
      }
      for (let i = 0; i < line.length; i += TELEGRAM_CHUNK_LIMIT) {
        chunks.push(line.slice(i, i + TELEGRAM_CHUNK_LIMIT));
      }
      continue;
    }
    const candidate = buffer.length === 0 ? line : `${buffer}\n${line}`;
    if (candidate.length > TELEGRAM_CHUNK_LIMIT) {
      chunks.push(buffer);
      buffer = line;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/**
 * Inline keyboard with a single regular URL button. Tapping it opens the URL
 * in the user's external browser.
 * Used for the slot-pattern Cartridge auth flow where the redirect target is
 * an HTTPS URL Telegram itself never sees.
 */
export function urlButton(text: string, url: string): { inline_keyboard: InlineKeyboardButton[][] } {
  return { inline_keyboard: [[{ text, url }]] };
}
