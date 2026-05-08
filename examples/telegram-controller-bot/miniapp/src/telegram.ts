// Thin wrapper over Telegram's WebApp JS API. Only the surface we need.
// The script tag in index.html populates window.Telegram.WebApp; this module
// reads from there safely so the Mini App still renders if loaded outside
// Telegram (for local dev).

interface TelegramWebApp {
  ready: () => void;
  close: () => void;
  expand: () => void;
  initDataUnsafe?: { start_param?: string };
  themeParams?: Record<string, string>;
  colorScheme?: "light" | "dark";
}

export function getWebApp(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  const tg = (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram;
  return tg?.WebApp ?? null;
}

export function tgReady(): void {
  getWebApp()?.ready();
}

export function tgClose(): void {
  const app = getWebApp();
  if (app) {
    app.close();
  } else {
    // Outside Telegram (local browser dev) — best-effort visual cue.
    console.info("Telegram.WebApp not available; nothing to close.");
  }
}

export function tgExpand(): void {
  getWebApp()?.expand();
}
