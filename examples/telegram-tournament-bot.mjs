#!/usr/bin/env node
// @ts-check
/**
 * Budokan tournament Telegram bot — a dependency-free reference implementation.
 *
 * Demonstrates how to drive the read side of the Budokan SDK from a plain
 * Node process: list/inspect tournaments, leaderboards and prizes, and push
 * live updates over the SDK's WebSocket. It is intentionally **read-only** —
 * anything that needs a signature (entering, submitting a score, claiming a
 * prize) is surfaced as a deeplink to the Budokan web app, where the user's
 * own wallet signs. The bot never holds keys.
 *
 * Zero npm dependencies: it uses only Node built-ins (`fetch`, the global
 * `WebSocket`, `process`) plus the Budokan SDK it ships with. Requires
 * Node >= 22 (stable global `WebSocket`).
 *
 * Run:
 *   bun run build                      # build the SDK's dist/ first
 *   TELEGRAM_BOT_TOKEN=... node examples/telegram-tournament-bot.mjs
 *
 * See telegram-tournament-bot.md for full setup, testing and deployment.
 */

import {
  createBudokanClient,
  tournamentPageUrl,
} from "@provable-games/budokan-sdk";

// ---------------------------------------------------------------------------
// Config (environment)
// ---------------------------------------------------------------------------

const TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const CHAIN = process.env.BUDOKAN_CHAIN ?? "mainnet"; // "mainnet" | "sepolia"
const API_BASE_URL = process.env.BUDOKAN_API_BASE_URL; // optional override
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// The SDK resolves apiBaseUrl/wsUrl/addresses from the chain preset; pass an
// explicit apiBaseUrl only when you run against a non-default deployment.
const client = createBudokanClient({
  chain: CHAIN,
  ...(API_BASE_URL ? { apiBaseUrl: API_BASE_URL } : {}),
});

// ---------------------------------------------------------------------------
// Telegram Bot API helpers (long-polling, no webhook / no deps)
// ---------------------------------------------------------------------------

/** Call a Telegram Bot API method and return its `result`. */
async function tg(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

/** Send an HTML message; web previews are disabled so deeplinks stay compact. */
function send(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  }).catch((e) => console.error("sendMessage failed:", e.message));
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTime(unixSecondsString) {
  const n = Number(unixSecondsString);
  if (!Number.isFinite(n) || n === 0) return "—";
  return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Scale a raw token amount by its decimals for display (best-effort, 18dp default). */
function fmtAmount(raw, decimals = 18) {
  try {
    const v = BigInt(raw ?? "0");
    const base = 10n ** BigInt(decimals);
    const whole = v / base;
    const frac = (v % base).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch {
    return String(raw ?? "0");
  }
}

function tournamentSummary(t) {
  const phase = t.phase ? ` · <i>${esc(t.phase)}</i>` : "";
  return `#${esc(t.id)} — <b>${esc(t.name || "Untitled")}</b>${phase} · 👥 ${t.entryCount} · 🏆 ${t.prizeCount}`;
}

function tournamentDetail(t) {
  const lines = [
    `<b>${esc(t.name || "Untitled")}</b> (#${esc(t.id)})`,
    t.phase ? `Phase: <b>${esc(t.phase)}</b>` : null,
    `Entrants: ${t.entryCount} · Prizes: ${t.prizeCount} · Submissions: ${t.submissionCount}`,
    `Game start: ${fmtTime(t.gameStartTime)}`,
    `Game end: ${fmtTime(t.gameEndTime)}`,
    `Submission end: ${fmtTime(t.submissionEndTime)}`,
  ];
  if (t.entryFee) {
    lines.push(
      `Entry fee: ${fmtAmount(t.entryFee.amount)} @ <code>${esc(short(t.entryFeeToken))}</code>`,
    );
  } else if (t.entryFeeKind === "extension") {
    lines.push("Entry fee: extension-managed");
  } else {
    lines.push("Entry fee: free");
  }
  lines.push("", `🔗 ${tournamentPageUrl(CHAIN, t.id)}`);
  return lines.filter((l) => l !== null).join("\n");
}

const short = (addr) =>
  addr ? `${String(addr).slice(0, 6)}…${String(addr).slice(-4)}` : "—";

// ---------------------------------------------------------------------------
// Command handlers (read-only)
// ---------------------------------------------------------------------------

const HELP = [
  "<b>Budokan tournament bot</b> (read-only)",
  "",
  "/tournaments — latest tournaments",
  "/tournament &lt;id&gt; — details for one tournament",
  "/leaderboard &lt;id&gt; — current standings",
  "/prizes &lt;id&gt; — prize pool",
  "/watch &lt;id&gt; — live updates in this chat (registrations, prizes, claims)",
  "/unwatch &lt;id&gt; — stop live updates",
  "",
  "<b>Actions</b> (open in the Budokan app to sign):",
  "/enter &lt;id&gt; · /claim &lt;id&gt; · /create",
].join("\n");

async function cmdTournaments(chatId) {
  const { data } = await client.getTournaments({ limit: 5, sort: "created_at" });
  if (!data.length) return send(chatId, "No tournaments found.");
  const body = data.map(tournamentSummary).join("\n");
  return send(chatId, `<b>Latest tournaments</b>\n${body}\n\nUse /tournament &lt;id&gt; for details.`);
}

async function cmdTournament(chatId, id) {
  if (!id) return send(chatId, "Usage: /tournament &lt;id&gt;");
  const t = await client.getTournament(id);
  if (!t) return send(chatId, `Tournament #${esc(id)} not found.`);
  return send(chatId, tournamentDetail(t));
}

async function cmdLeaderboard(chatId, id) {
  if (!id) return send(chatId, "Usage: /leaderboard &lt;id&gt;");
  const lb = await client.getTournamentLeaderboard(id);
  if (!lb.length) return send(chatId, `No scores submitted yet for #${esc(id)}.`);
  const rows = lb
    .slice(0, 10)
    .map((e) => `${e.position}. token <code>${esc(short(e.tokenId))}</code>`)
    .join("\n");
  return send(chatId, `<b>Leaderboard #${esc(id)}</b> (top ${Math.min(lb.length, 10)})\n${rows}`);
}

async function cmdPrizes(chatId, id) {
  if (!id) return send(chatId, "Usage: /prizes &lt;id&gt;");
  const prizes = await client.getTournamentPrizes(id);
  if (!prizes.length) return send(chatId, `No sponsored prizes for #${esc(id)}.`);
  const rows = prizes.slice(0, 15).map((p) => {
    if (p.tokenType === "erc20") return `• ${fmtAmount(p.amount)} ERC-20 <code>${esc(short(p.tokenAddress))}</code>`;
    if (p.tokenType === "erc721") return `• NFT #${esc(p.tokenId)} <code>${esc(short(p.tokenAddress))}</code>`;
    return `• extension prize <code>${esc(short(p.extensionAddress))}</code>`;
  });
  const more = prizes.length > 15 ? `\n…and ${prizes.length - 15} more` : "";
  return send(chatId, `<b>Prizes #${esc(id)}</b> (${prizes.length})\n${rows.join("\n")}${more}`);
}

/** Signing actions are deeplinked to the Budokan app — the bot holds no keys. */
function cmdDeeplink(chatId, id, action) {
  if (action !== "create" && !id) return send(chatId, `Usage: /${action} &lt;id&gt;`);
  const url = id ? tournamentPageUrl(CHAIN, id) : `https://budokan.gg/?network=${CHAIN}`;
  const verb = { enter: "Enter", claim: "Claim prizes for", create: "Create a tournament" }[action];
  const label = id ? `${verb} tournament #${esc(id)}` : verb;
  return send(chatId, `${label} in the Budokan app (sign with your wallet):\n🔗 ${url}`);
}

// ---------------------------------------------------------------------------
// Live updates over the SDK WebSocket (/watch, /unwatch)
// ---------------------------------------------------------------------------

// key `${chatId}:${tournamentId}` -> unsubscribe fn
const watchers = new Map();
let wsConnected = false;

function cmdWatch(chatId, id) {
  if (!id) return send(chatId, "Usage: /watch &lt;id&gt;");
  const key = `${chatId}:${id}`;
  if (watchers.has(key)) return send(chatId, `Already watching #${esc(id)}.`);

  if (!wsConnected) {
    client.connect();
    wsConnected = true;
  }
  // Filtering by tournamentIds keeps the bot from being spammed by unrelated
  // tournaments — the server only pushes events for the ids we ask for.
  const unsubscribe = client.subscribe(
    ["registrations", "prizes", "rewards"],
    (msg) => {
      const label = { registrations: "📝 new entry", prizes: "🎁 prize added", rewards: "💰 reward claimed" }[msg.channel] ?? msg.channel;
      send(chatId, `<b>#${esc(id)}</b> · ${label}`);
    },
    [String(id)],
  );
  watchers.set(key, unsubscribe);
  return send(chatId, `Watching #${esc(id)} — you'll get live updates here. /unwatch ${esc(id)} to stop.`);
}

function cmdUnwatch(chatId, id) {
  if (!id) return send(chatId, "Usage: /unwatch &lt;id&gt;");
  const key = `${chatId}:${id}`;
  const unsubscribe = watchers.get(key);
  if (!unsubscribe) return send(chatId, `Not watching #${esc(id)}.`);
  unsubscribe();
  watchers.delete(key);
  return send(chatId, `Stopped watching #${esc(id)}.`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  if (!text.startsWith("/")) return;

  // Strip a trailing @botname (group chats) and split into command + args.
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const id = args[0];

  try {
    switch (cmd) {
      case "/start":
      case "/help":
        return await send(chatId, HELP);
      case "/tournaments":
        return await cmdTournaments(chatId);
      case "/tournament":
        return await cmdTournament(chatId, id);
      case "/leaderboard":
        return await cmdLeaderboard(chatId, id);
      case "/prizes":
        return await cmdPrizes(chatId, id);
      case "/watch":
        return cmdWatch(chatId, id);
      case "/unwatch":
        return cmdUnwatch(chatId, id);
      case "/enter":
        return cmdDeeplink(chatId, id, "enter");
      case "/claim":
        return cmdDeeplink(chatId, id, "claim");
      case "/create":
        return cmdDeeplink(chatId, id, "create");
      default:
        return await send(chatId, "Unknown command. /help for the list.");
    }
  } catch (e) {
    console.error(`handler ${cmd} failed:`, e);
    return send(chatId, `⚠️ ${esc(e.message || "Something went wrong.")}`);
  }
}

// ---------------------------------------------------------------------------
// Long-poll loop + lifecycle
// ---------------------------------------------------------------------------

let running = true;

async function pollLoop() {
  let offset = 0;
  console.log(`Bot started on chain "${CHAIN}". Polling for updates…`);
  while (running) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 30 });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message?.text) await handleMessage(u.message);
      }
    } catch (e) {
      if (!running) break;
      console.error("poll error:", e.message);
      await new Promise((r) => setTimeout(r, 3000)); // back off on transient errors
    }
  }
}

function shutdown() {
  running = false;
  for (const unsubscribe of watchers.values()) unsubscribe();
  watchers.clear();
  client.destroy();
  console.log("Bot stopped.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

pollLoop();
