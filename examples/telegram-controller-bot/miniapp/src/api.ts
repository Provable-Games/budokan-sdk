// Bot HTTP client. Talks to the Fastify server defined in
// server/src/http.ts. Both endpoints live behind VITE_BOT_PUBLIC_URL.

import type { ConnectInfoResponse, ConnectPostBody } from "./types.ts";

const BOT_URL = import.meta.env.VITE_BOT_PUBLIC_URL?.replace(/\/$/, "") ?? "";

if (!BOT_URL) {
  console.warn("VITE_BOT_PUBLIC_URL is not set. Mini App will fail to talk to the bot.");
}

export async function fetchConnectInfo(token: string): Promise<ConnectInfoResponse> {
  const res = await fetch(`${BOT_URL}/api/connect/${encodeURIComponent(token)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) {
    throw new Error("This authorization link has expired or already been used. Run /connect again.");
  }
  if (!res.ok) {
    throw new Error(`Bot returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as ConnectInfoResponse;
}

export async function postConnectSession(token: string, body: ConnectPostBody): Promise<void> {
  const res = await fetch(`${BOT_URL}/api/connect/${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) {
    throw new Error("This authorization link has expired or already been used.");
  }
  if (!res.ok) {
    throw new Error(`Bot rejected session: ${res.status} — ${await safeText(res)}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
