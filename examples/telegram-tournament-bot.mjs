#!/usr/bin/env node

/**
 * Budokan Telegram tournament bot reference implementation.
 *
 * This file is intentionally dependency-free so it is easy for developers and
 * AI agents to copy, inspect, and adapt. It uses:
 * - Telegram long polling (`getUpdates`) for bot commands
 * - Budokan WebSocket subscriptions for live tournament/registration/prize/reward updates
 * - A small local JSON file for chat/tournament registrations
 *
 * The Budokan SDK is read-only — the bot displays data and pushes notifications.
 * Actions that require signing (entering a tournament, submitting a score,
 * claiming a prize) are surfaced as deeplinks to the Budokan web app.
 *
 * Run from the repository root after building the SDK:
 *   TELEGRAM_BOT_TOKEN=123:abc node examples/telegram-tournament-bot.mjs
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  createBudokanClient,
  normalizeAddress as normalizeSdkAddress,
} from "@provable-games/budokan-sdk";

function loadConfig() {
  const telegramBotToken = env("TELEGRAM_BOT_TOKEN");
  if (!telegramBotToken) {
    console.error("TELEGRAM_BOT_TOKEN is required.");
    process.exit(1);
  }

  const chain = env("BUDOKAN_CHAIN") ?? "mainnet";
  if (chain !== "mainnet" && chain !== "sepolia") {
    console.error("BUDOKAN_CHAIN must be either 'mainnet' or 'sepolia'.");
    process.exit(1);
  }

  return {
    telegramBotToken,
    registrationsFile: env("REGISTRATIONS_FILE") ?? ".telegram-tournament-bot-registrations.json",
    chain,
    apiBaseUrl: env("BUDOKAN_API_URL"),
    wsUrl: env("BUDOKAN_WS_URL"),
    rpcUrl: env("BUDOKAN_RPC_URL"),
    budokanAddress: env("BUDOKAN_ADDRESS"),
    viewerAddress: env("BUDOKAN_VIEWER_ADDRESS"),
    webUrl: (env("BUDOKAN_WEB_URL") ?? "https://budokan.gg").replace(/\/$/, ""),
    // Username (without the leading @) of the companion controller bot that
    // signs in DM. When set, /play and /claim offer an "in Telegram" option
    // that deep-links into a private chat with that bot. When unset, those
    // commands fall back to the budokan.gg browser link only.
    playBotUsername: env("PLAY_BOT_USERNAME")?.replace(/^@/, ""),
  };
}

function env(name) {
  return process.env[name]?.trim() || undefined;
}

const config = loadConfig();
const TELEGRAM_API = `https://api.telegram.org/bot${config.telegramBotToken}`;
const REGISTRATIONS_FILE = config.registrationsFile;
const telegramPollingAbortController = new AbortController();
const SUPPORTED_CHAINS = ["mainnet", "sepolia"];
// Telegram caps text messages at 4096 characters; we leave headroom for safety
// and split at line boundaries so the rendered output stays readable. Declared
// up here so `sendMessage` (called from the top-level await pollTelegram()) can
// access it without hitting a TDZ — top-level await suspends module init at
// the first await, leaving any `const` defined later in the file uninitialized.
const TELEGRAM_CHUNK_LIMIT = 3900;

// Known ERC-20 tokens by normalized address. Used to render prize amounts and
// entry fees in human-readable units. For tokens not in this map the bot falls
// back to 18-decimal formatting (the Starknet default) — extend as needed.
const KNOWN_TOKENS = {
  "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7": { symbol: "ETH", decimals: 18 },
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d": { symbol: "STRK", decimals: 18 },
  "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8": { symbol: "USDC", decimals: 6 },
  "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8": { symbol: "USDT", decimals: 6 },
  "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49": { symbol: "LORDS", decimals: 18 },
  "0x05574eb6b8789a91466f902c380d978e472db68170ff82a5b650b95a58ddf4ad": { symbol: "DAI", decimals: 18 },
};

// Per-bot chain state. Default from BUDOKAN_CHAIN env var; switch at runtime
// via /chain. Tournament IDs collide across networks (both chains have small
// integer IDs), so registrations are namespaced by chain — see
// sanitizeRegistrations below.
let currentChain = config.chain;
let client = buildClient(currentChain);
attachClientHooks();

let registrations = await loadRegistrations();
let unsubscribeBudokan = null;
let stopping = false;

function buildClient(chain) {
  return createBudokanClient({
    chain,
    apiBaseUrl: config.apiBaseUrl,
    wsUrl: config.wsUrl,
    rpcUrl: config.rpcUrl,
    budokanAddress: config.budokanAddress,
    viewerAddress: config.viewerAddress,
  });
}

function attachClientHooks() {
  client.onWsConnectionChange((connected) => {
    console.log(`Budokan WebSocket [${currentChain}] ${connected ? "connected" : "disconnected"}`);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await telegram("deleteWebhook", { drop_pending_updates: false });
await registerCommandMenu();
refreshBudokanSubscription();
console.log("Telegram tournament bot is running.");
await pollTelegram();

async function loadRegistrations() {
  if (!existsSync(REGISTRATIONS_FILE)) return emptyRegistrations();

  try {
    const raw = await readFile(REGISTRATIONS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return sanitizeRegistrations(parsed);
  } catch (error) {
    console.warn(`Could not load ${REGISTRATIONS_FILE}; starting with no registrations: ${formatError(error)}`);
    return emptyRegistrations();
  }
}

function emptyRegistrations() {
  const tournaments = {};
  for (const c of SUPPORTED_CHAINS) tournaments[c] = {};
  return { tournaments };
}

// Persisted shape (chain-namespaced):
// {
//   "tournaments": {
//     "mainnet": { "<tournamentId>": { "chatIds": ["123"] } },
//     "sepolia": { "<tournamentId>": { "chatIds": ["456"] } }
//   }
// }
//
// Legacy shape (pre-/chain support):
// {
//   "tournaments": { "<tournamentId>": { "chatIds": [...] } }
// }
// Legacy entries are migrated into the mainnet namespace on first load so
// existing follows aren't lost.
function sanitizeRegistrations(value) {
  const output = emptyRegistrations();
  if (!value || typeof value !== "object" || !value.tournaments || typeof value.tournaments !== "object") {
    return output;
  }

  const inner = value.tournaments;
  const looksChainNamespaced = SUPPORTED_CHAINS.some((c) => inner[c] !== undefined && typeof inner[c] === "object");

  if (looksChainNamespaced) {
    for (const chain of SUPPORTED_CHAINS) {
      const chainInner = inner[chain];
      if (!chainInner || typeof chainInner !== "object") continue;
      for (const [tournamentId, entry] of Object.entries(chainInner)) {
        const id = normalizeTournamentId(tournamentId);
        if (!id || !entry || typeof entry !== "object" || !Array.isArray(entry.chatIds)) continue;
        const chatIds = [...new Set(entry.chatIds.map(String).filter(Boolean))];
        if (chatIds.length === 0) continue;
        output.tournaments[chain][id] = { chatIds };
      }
    }
    return output;
  }

  // Legacy: flat tournament-id keys. Treat as mainnet entries.
  for (const [tournamentId, entry] of Object.entries(inner)) {
    const id = normalizeTournamentId(tournamentId);
    if (!id || !entry || typeof entry !== "object" || !Array.isArray(entry.chatIds)) continue;
    const chatIds = [...new Set(entry.chatIds.map(String).filter(Boolean))];
    if (chatIds.length === 0) continue;
    output.tournaments.mainnet[id] = { chatIds };
  }
  return output;
}

// The followed-tournament map for the chain the bot is currently pointed at.
// Mutate the returned object directly; saveRegistrations persists the parent.
function activeTournaments() {
  if (!registrations.tournaments[currentChain]) {
    registrations.tournaments[currentChain] = {};
  }
  return registrations.tournaments[currentChain];
}

async function saveRegistrations() {
  const dir = dirname(REGISTRATIONS_FILE);
  if (dir && dir !== ".") await mkdir(dir, { recursive: true });

  const tmpFile = `${REGISTRATIONS_FILE}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(registrations, null, 2)}\n`);
  await rename(tmpFile, REGISTRATIONS_FILE);
}

function refreshBudokanSubscription() {
  if (unsubscribeBudokan) {
    unsubscribeBudokan();
    unsubscribeBudokan = null;
  }

  const tournamentIds = Object.entries(activeTournaments())
    .filter(([, entry]) => entry.chatIds.length > 0)
    .map(([id]) => id);

  if (tournamentIds.length === 0) {
    console.log(`No followed tournaments on ${currentChain}. Waiting for /follow commands.`);
    return;
  }

  client.connect();
  unsubscribeBudokan = client.subscribe(
    ["tournaments", "registrations", "prizes", "rewards"],
    (message) => {
      handleBudokanMessage(message).catch((error) => {
        console.error(`WS handler failed: ${formatError(error)}`);
      });
    },
    tournamentIds,
  );
  console.log(`Subscribed to updates for ${tournamentIds.length} tournament(s) on ${currentChain}.`);
}

async function handleBudokanMessage(message) {
  if (
    message.channel !== "tournaments" &&
    message.channel !== "registrations" &&
    message.channel !== "prizes" &&
    message.channel !== "rewards"
  ) return;

  const event = mapTournamentEvent(message.data);
  if (!event.tournamentId) return;

  const registration = activeTournaments()[event.tournamentId];
  if (!registration) return;

  const text = formatEvent(message.channel, event);
  if (!text) return;

  const results = await Promise.allSettled(
    registration.chatIds.map((chatId) => sendMessage(chatId, text)),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(`Telegram send failed: ${formatError(result.reason)}`);
    }
  }
  // Production note: if Telegram returns 400/403 for a chat that blocked or
  // removed the bot, remove that chat from registrations to stop retrying.
}

// WebSocket payloads currently arrive as snake_case from the API, but this
// accepts camelCase too so the example keeps working if the SDK mapper layer
// is reused before messages reach this script.
function mapTournamentEvent(data) {
  const raw = data && typeof data === "object" ? data : {};
  const idValue = raw.tournament_id ?? raw.tournamentId ?? raw.id;
  return {
    tournamentId: idValue !== undefined && idValue !== null ? String(idValue) : "",
    name: raw.name !== undefined ? String(raw.name) : "",
    phase: raw.phase !== undefined ? String(raw.phase) : "",
    eventType: raw.event_type ?? raw.eventType ?? raw.type ?? "",
    gameTokenId: String(raw.game_token_id ?? raw.gameTokenId ?? ""),
    entryNumber: raw.entry_number ?? raw.entryNumber ?? null,
    score: raw.score ?? null,
    position: raw.position ?? null,
    tokenAddress: raw.token_address ?? raw.tokenAddress ?? "",
    tokenType: raw.token_type ?? raw.tokenType ?? "",
    amount: raw.amount ?? null,
    payoutPosition: raw.payout_position ?? raw.payoutPosition ?? null,
    claimKind: raw.claim_kind ?? raw.claimKind ?? "",
    raw,
  };
}

// Telegram long polling. `deleteWebhook` is called at startup because
// `getUpdates` can return a conflict when a webhook is configured.
async function pollTelegram() {
  let offset;

  while (!stopping) {
    try {
      const result = await telegram("getUpdates", {
        timeout: 50,
        offset,
        allowed_updates: ["message"],
      }, {
        signal: telegramPollingAbortController.signal,
      });

      for (const update of result) {
        offset = update.update_id + 1;
        if (update.message?.text) {
          try {
            await handleTelegramMessage(update.message);
          } catch (handlerError) {
            console.error(`Command handler failed: ${formatError(handlerError)}`);
            // Best-effort error notice. Wrap in try/catch because the most
            // likely cause of a handler throw is a failed send — telling the
            // user about it could hit the same failure.
            try {
              await sendMessage(
                String(update.message.chat.id),
                `Sorry, that command failed: ${formatError(handlerError)}`,
              );
            } catch (notifyError) {
              console.error(`Failed to notify user of error: ${formatError(notifyError)}`);
            }
          }
        }
      }
    } catch (error) {
      if (stopping || isAbortError(error)) break;
      console.error(`Telegram polling failed: ${formatError(error)}`);
      await sleep(2000, telegramPollingAbortController.signal);
    }
  }
}

async function handleTelegramMessage(message) {
  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();

  if (command === "/start" || command === "/help") {
    await sendMessage(chatId, helpText());
    return;
  }

  if (command === "/follow") {
    await followTournament(chatId, args[0]);
    return;
  }

  if (command === "/unfollow") {
    await unfollowTournament(chatId, args[0]);
    return;
  }

  if (command === "/following") {
    await listFollowing(chatId);
    return;
  }

  if (command === "/tournament") {
    await sendTournamentDetail(chatId, args[0]);
    return;
  }

  if (command === "/leaderboard") {
    await sendLeaderboard(chatId, args[0]);
    return;
  }

  if (command === "/prizes") {
    await sendPrizes(chatId, args[0]);
    return;
  }

  if (command === "/tournaments") {
    await sendTournamentList(chatId, args[0]);
    return;
  }

  if (command === "/play") {
    await sendPlayLink(chatId, args[0]);
    return;
  }

  if (command === "/claim") {
    await sendClaimLink(chatId, args[0]);
    return;
  }

  // Signing actions don't live in this read-only bot — redirect to the DM
  // signer bot rather than silently ignoring the command. These are the
  // commands users most often try here out of habit.
  if (command === "/connect") {
    await sendConnectLink(chatId);
    return;
  }

  if (command === "/create") {
    await sendCreateLink(chatId);
    return;
  }

  if (command === "/chain") {
    await handleChainCommand(chatId, args[0]);
  }
}

async function handleChainCommand(chatId, arg) {
  if (!arg) {
    await sendMessage(
      chatId,
      `Current chain: ${currentChain}\nUsage: /chain ${SUPPORTED_CHAINS.join("|")}`,
    );
    return;
  }
  const target = arg.toLowerCase();
  if (!SUPPORTED_CHAINS.includes(target)) {
    await sendMessage(chatId, `Chain must be one of: ${SUPPORTED_CHAINS.join(", ")}`);
    return;
  }
  if (target === currentChain) {
    await sendMessage(chatId, `Already on ${currentChain}.`);
    return;
  }

  // Tear down the existing client + subscription, swap chains, rebuild.
  if (unsubscribeBudokan) {
    unsubscribeBudokan();
    unsubscribeBudokan = null;
  }
  client.destroy();
  currentChain = target;
  client = buildClient(currentChain);
  attachClientHooks();
  refreshBudokanSubscription();

  const followCount = Object.values(activeTournaments()).filter((e) => e.chatIds.length > 0).length;
  await sendMessage(
    chatId,
    `Switched to ${currentChain}. ${followCount} tournament(s) followed on this chain.\nFollows on the other chain are preserved — switch back with /chain to resume them.`,
  );
}

async function followTournament(chatId, inputId) {
  const tournamentId = normalizeTournamentId(inputId);
  if (!tournamentId) {
    await sendMessage(chatId, "Usage: /follow <tournamentId>");
    return;
  }

  // Verify the tournament exists before persisting the follow.
  let tournament;
  try {
    tournament = await client.getTournament(tournamentId);
  } catch (error) {
    await sendMessage(chatId, `Could not load tournament: ${formatError(error)}`);
    return;
  }
  if (!tournament) {
    await sendMessage(chatId, `Tournament ${tournamentId} not found.`);
    return;
  }

  const map = activeTournaments();
  const entry = map[tournamentId] ?? { chatIds: [] };
  if (!entry.chatIds.includes(chatId)) entry.chatIds.push(chatId);
  map[tournamentId] = entry;
  await saveRegistrations();
  refreshBudokanSubscription();

  await sendMessage(
    chatId,
    `Following tournament ${tournamentId} on ${currentChain} — ${tournament.name || "(unnamed)"}\nLive updates will be posted here.`,
  );
}

async function unfollowTournament(chatId, inputId) {
  const map = activeTournaments();

  if (inputId) {
    const tournamentId = normalizeTournamentId(inputId);
    if (!tournamentId) {
      await sendMessage(chatId, "Usage: /unfollow <tournamentId>  (or /unfollow to drop all)");
      return;
    }

    const entry = map[tournamentId];
    if (entry) {
      entry.chatIds = entry.chatIds.filter((id) => id !== chatId);
      if (entry.chatIds.length === 0) delete map[tournamentId];
    }
    await saveRegistrations();
    refreshBudokanSubscription();
    await sendMessage(chatId, `Unfollowed tournament ${tournamentId} on ${currentChain}.`);
    return;
  }

  let removed = 0;
  for (const [id, entry] of Object.entries(map)) {
    const before = entry.chatIds.length;
    entry.chatIds = entry.chatIds.filter((cid) => cid !== chatId);
    removed += before - entry.chatIds.length;
    if (entry.chatIds.length === 0) delete map[id];
  }

  await saveRegistrations();
  refreshBudokanSubscription();
  await sendMessage(
    chatId,
    removed > 0
      ? `Unfollowed all tournaments in this chat on ${currentChain}.`
      : `This chat is not following any tournaments on ${currentChain}.`,
  );
}

async function listFollowing(chatId) {
  const ids = chatTournamentIds(chatId);
  if (ids.length === 0) {
    await sendMessage(chatId, `Not following any tournaments on ${currentChain}. Use /follow <tournamentId>.`);
    return;
  }

  await sendMessage(chatId, `Following on ${currentChain}:\n${ids.map((id) => `- ${id}`).join("\n")}`);
}

async function sendTournamentDetail(chatId, inputId) {
  const tournamentId = normalizeTournamentId(inputId);
  if (!tournamentId) {
    await sendMessage(chatId, "Usage: /tournament <tournamentId>");
    return;
  }

  let tournament;
  try {
    tournament = await client.getTournament(tournamentId);
  } catch (error) {
    await sendMessage(chatId, `Lookup failed: ${formatError(error)}`);
    return;
  }
  if (!tournament) {
    await sendMessage(chatId, `Tournament ${tournamentId} not found.`);
    return;
  }

  await sendMessage(chatId, formatTournament(tournament));
}

async function sendLeaderboard(chatId, inputId) {
  const tournamentId = normalizeTournamentId(inputId);
  if (!tournamentId) {
    await sendMessage(chatId, "Usage: /leaderboard <tournamentId>");
    return;
  }

  try {
    const entries = await client.getTournamentLeaderboard(tournamentId);
    if (!entries.length) {
      await sendMessage(chatId, `No leaderboard entries yet for ${tournamentId}.`);
      return;
    }
    const lines = entries
      .slice(0, 20)
      .map((entry) => `${entry.position}. ${shortHex(entry.tokenId)}`);
    if (entries.length > 20) lines.push(`...and ${entries.length - 20} more.`);
    await sendMessage(chatId, [`Leaderboard for ${tournamentId}`, ...lines].join("\n"));
  } catch (error) {
    await sendMessage(chatId, `Lookup failed: ${formatError(error)}`);
  }
}

async function sendPrizes(chatId, inputId) {
  const tournamentId = normalizeTournamentId(inputId);
  if (!tournamentId) {
    await sendMessage(chatId, "Usage: /prizes <tournamentId>");
    return;
  }

  let prizes;
  let claims = [];
  try {
    // Fetch claims in parallel; tolerate failure (older indexers may not
    // surface claims for every tournament). The display still works without.
    const [prizesResult, claimsResult] = await Promise.allSettled([
      client.getTournamentPrizes(tournamentId),
      client.getTournamentRewardClaims(tournamentId, { limit: 200 }),
    ]);
    if (prizesResult.status === "rejected") throw prizesResult.reason;
    prizes = prizesResult.value;
    if (claimsResult.status === "fulfilled") claims = claimsResult.value.data ?? [];
  } catch (error) {
    await sendMessage(chatId, `Lookup failed: ${formatError(error)}`);
    return;
  }

  if (!prizes.length) {
    await sendMessage(chatId, `No prizes posted yet for ${tournamentId}.`);
    return;
  }

  const claimMap = buildClaimMap(claims);
  const sections = prizes.map((prize) => formatPrizeSection(prize, claimMap));
  await sendMessage(chatId, [`Prizes for ${tournamentId}`, "", ...sections].join("\n\n"));
}

// Build a lookup of (prizeId, payoutIndex) → claimed boolean. The indexer's
// payoutIndex is 1-based — it's the leaderboard position the contract emits
// verbatim (see _claim_distributed_prize: asserts payout_index > 0). So it
// matches `payoutPosition` directly, not `position - 1`. Single-position
// prizes use the sentinel "single".
function buildClaimMap(claims) {
  const map = new Map();
  for (const c of claims) {
    if (!c.claimed || !c.prizeId) continue;
    const key = c.payoutIndex !== null && c.payoutIndex !== undefined
      ? `${c.prizeId}:${c.payoutIndex}`
      : `${c.prizeId}:single`;
    map.set(key, true);
  }
  return map;
}

// Render one prize as either a pool block (header + indented per-position
// lines) or a single line, depending on whether it's a distributed pool.
function formatPrizeSection(prize, claimMap) {
  if (isDistributedPool(prize)) {
    return formatPoolBlock(prize, claimMap);
  }
  const claimed = claimMap.get(`${prize.prizeId}:single`);
  return formatSinglePrizeLine(prize, claimed);
}

function isDistributedPool(prize) {
  if (prize.tokenType !== "erc20") return false;
  const pos = prize.payoutPosition;
  if (pos !== 0 && pos !== null) return false;
  return Number(prize.distributionCount ?? 0) > 0;
}

function formatPoolBlock(prize, claimMap) {
  const expanded = expandPrize(prize);
  const distType = String(prize.distributionType ?? "uniform").toLowerCase();
  const distCount = Number(prize.distributionCount ?? expanded.length);
  const totalLabel = formatErc20(prize.amount, prize.tokenAddress);
  const header = `Pool: ${totalLabel} (${distType}, ${distCount} place${distCount === 1 ? "" : "s"})`;
  const rows = expanded.map((row) => {
    const claimed = claimMap.get(`${prize.prizeId}:${row.payoutPosition}`);
    const suffix = claimed ? " (claimed)" : "";
    return `  ${row.payoutPosition}. ${formatErc20(row.amount, row.tokenAddress)}${suffix}`;
  });
  return [header, ...rows].join("\n");
}

function formatSinglePrizeLine(prize, claimed) {
  const suffix = claimed ? " (claimed)" : "";
  if (prize.tokenType === "erc721") {
    return `Pos ${prize.payoutPosition}: NFT ${shortHex(prize.tokenId ?? "")} from ${shortHex(prize.tokenAddress)}${suffix}`;
  }
  return `Pos ${prize.payoutPosition}: ${formatErc20(prize.amount, prize.tokenAddress)}${suffix}`;
}

async function sendTournamentList(chatId, phaseArg) {
  const phase = normalizePhase(phaseArg);
  if (phaseArg && !phase) {
    await sendMessage(chatId, "Usage: /tournaments [scheduled|registration|staging|live|submission|finalized]");
    return;
  }

  try {
    const result = await client.getTournaments({
      phase,
      limit: 10,
      sort: "created_at",
    });
    if (!result.data.length) {
      await sendMessage(chatId, phase ? `No ${phase} tournaments.` : "No tournaments found.");
      return;
    }
    const lines = result.data.map((t) => `${t.id} — ${t.name || "(unnamed)"} (entries: ${t.entryCount})`);
    const header = phase
      ? `Tournaments in phase '${phase}' (showing ${result.data.length}/${result.total}):`
      : `Recent tournaments (showing ${result.data.length}/${result.total}):`;
    await sendMessage(chatId, [header, ...lines].join("\n"));
  } catch (error) {
    await sendMessage(chatId, `Lookup failed: ${formatError(error)}`);
  }
}

async function sendPlayLink(chatId, inputId) {
  const tournamentId = normalizeTournamentId(inputId);
  if (!tournamentId) {
    await sendMessage(chatId, "Usage: /play <tournamentId>");
    return;
  }
  await sendMessage(chatId, handoffMessage("enter", tournamentId));
}

async function sendClaimLink(chatId, inputId) {
  const tournamentId = normalizeTournamentId(inputId);
  if (!tournamentId) {
    await sendMessage(chatId, "Usage: /claim <tournamentId>");
    return;
  }
  await sendMessage(chatId, handoffMessage("claim", tournamentId));
}

function chatTournamentIds(chatId) {
  return Object.entries(activeTournaments())
    .filter(([, entry]) => entry.chatIds.includes(chatId))
    .map(([id]) => id);
}

function formatEvent(channel, event) {
  const header = `Tournament ${event.tournamentId}`;
  const link = `Open: ${tournamentUrl(event.tournamentId)}`;

  if (channel === "tournaments") {
    const lines = ["Tournament update", header];
    if (event.name) lines.push(`Name: ${event.name}`);
    if (event.phase) lines.push(`Phase: ${event.phase}`);
    if (event.eventType) lines.push(`Event: ${event.eventType}`);
    lines.push(link);
    return lines.join("\n");
  }

  if (channel === "registrations") {
    const lines = ["New registration", header];
    if (event.gameTokenId) lines.push(`Token: ${shortHex(event.gameTokenId)}`);
    if (event.entryNumber !== null) lines.push(`Entry #: ${event.entryNumber}`);
    if (event.score !== null) lines.push(`Score: ${event.score}`);
    if (event.position !== null) lines.push(`Position: ${event.position}`);
    lines.push(link);
    return lines.join("\n");
  }

  if (channel === "prizes") {
    const lines = ["Prize update", header];
    if (event.tokenType === "erc721") {
      lines.push(`Token: NFT from ${shortHex(event.tokenAddress)}`);
    } else if (event.tokenAddress) {
      lines.push(`Amount: ${formatErc20(event.amount, event.tokenAddress)}`);
    } else if (event.amount !== null) {
      lines.push(`Amount: ${event.amount}`);
    }
    if (event.payoutPosition !== null) lines.push(`Payout position: ${event.payoutPosition}`);
    lines.push(link);
    return lines.join("\n");
  }

  if (channel === "rewards") {
    const lines = ["Reward claimed", header];
    if (event.claimKind) lines.push(`Kind: ${event.claimKind}`);
    if (event.position !== null) lines.push(`Position: ${event.position}`);
    if (event.payoutPosition !== null) lines.push(`Payout position: ${event.payoutPosition}`);
    lines.push(link);
    return lines.join("\n");
  }

  return null;
}

function formatTournament(tournament) {
  const lines = [
    `Tournament ${tournament.id}`,
    `Name: ${tournament.name || "(unnamed)"}`,
  ];
  if (tournament.description) lines.push(`Description: ${tournament.description}`);
  lines.push(`Game: ${shortHex(tournament.gameAddress)}`);
  lines.push(`Entries: ${tournament.entryCount}`);
  lines.push(`Submissions: ${tournament.submissionCount}`);
  lines.push(`Prizes posted: ${tournament.prizeCount}`);
  if (tournament.registrationStartTime) lines.push(`Registration: ${formatTimeRange(tournament.registrationStartTime, tournament.registrationEndTime)}`);
  if (tournament.gameStartTime) lines.push(`Live: ${formatTimeRange(tournament.gameStartTime, tournament.gameEndTime)}`);
  if (tournament.submissionEndTime) lines.push(`Submissions close: ${formatTimestamp(tournament.submissionEndTime)}`);
  if (tournament.entryFeeAmount) lines.push(`Entry fee: ${formatErc20(tournament.entryFeeAmount, tournament.entryFeeToken)}`);
  lines.push(`Open: ${tournamentUrl(tournament.id)}`);
  return lines.join("\n");
}

// A prize row with payoutPosition === 0 is a distributed pool — the indexer
// stores the pool total once and the per-position split is derived from
// distributionType + distributionCount + distributionWeight (or the explicit
// distributionShares array for custom). Expand it into per-position rows so
// each line shows the actual amount a placement will receive.
//
// Mirrors the client logic in
// budokan/client/src/lib/utils/prizeDistribution.ts and the canonical
// percentage formula in metagame-sdk/src/utils/formatting.ts:calculateDistribution.
function expandPrize(prize) {
  if (prize.payoutPosition !== 0 && prize.payoutPosition !== null) return [prize];
  if (prize.tokenType !== "erc20") return [prize];

  const distCount = Number(prize.distributionCount ?? 0);
  if (distCount <= 0) return [prize];

  const totalAmount = (() => {
    try { return BigInt(prize.amount ?? 0); } catch { return 0n; }
  })();
  const distType = String(prize.distributionType ?? "uniform").toLowerCase();
  // The client passes `distributionWeight / 10` to calculateDistribution;
  // mirror that so we land on the same percentages. Default weight is 10
  // (= 1.0 once divided), matching the client fallback.
  const rawWeight = Number(prize.distributionWeight ?? 10);

  let percentages;
  if (distType === "custom" && Array.isArray(prize.distributionShares) && prize.distributionShares.length > 0) {
    const totalShares = prize.distributionShares.reduce((a, b) => a + b, 0);
    percentages = totalShares === 0
      ? prize.distributionShares.map(() => 0)
      : prize.distributionShares.map((s) => (s / totalShares) * 100);
  } else {
    percentages = calculateDistributionPercentages(distCount, rawWeight / 10, distType);
  }

  return percentages.map((pct, index) => ({
    ...prize,
    payoutPosition: index + 1,
    amount: ((totalAmount * BigInt(Math.floor(pct * 100))) / 10000n).toString(),
    distributionType: null,
    distributionCount: null,
    distributionWeight: null,
    distributionShares: null,
  }));
}

// Percentage shares for a distributed prize pool. Returns an array of length
// `positions` summing to 100. Ported verbatim from
// metagame-sdk/src/utils/formatting.ts:calculateDistribution (the linear and
// exponential branches both use `weight` as already pre-scaled by the caller).
function calculateDistributionPercentages(positions, weight, distributionType) {
  if (positions <= 0) return [];

  let raw = [];
  if (distributionType === "uniform") {
    raw = Array(positions).fill(1);
  } else if (distributionType === "linear") {
    for (let i = 0; i < positions; i++) {
      const positionValue = positions - i;
      raw.push(1 + (positionValue - 1) * (weight / 10));
    }
  } else {
    // "exponential" (the contract default for unspecified types)
    for (let i = 0; i < positions; i++) {
      raw.push(Math.pow(1 - i / positions, weight));
    }
  }

  const total = raw.reduce((a, b) => a + b, 0);
  if (total === 0) return Array(positions).fill(0);

  const bp = raw.map((d) => Math.floor((d / total) * 10000));
  const remaining = 10000 - bp.reduce((a, b) => a + b, 0);
  if (remaining !== 0) bp[0] += remaining;
  return bp.map((b) => b / 100);
}

function tokenInfo(address) {
  if (typeof address !== "string" || address.length === 0) {
    return { symbol: null, decimals: 18 };
  }
  const key = normalizeSdkAddress(address);
  return KNOWN_TOKENS[key] ?? { symbol: null, decimals: 18 };
}

// Render a raw u256 ERC-20 amount using known decimals (or 18 as a default).
// Trailing zeros in the fractional part are stripped. Returns the symbol when
// known, falling back to a short token address.
function formatErc20(rawAmount, tokenAddress) {
  const info = tokenInfo(tokenAddress);
  const label = info.symbol ?? shortHex(tokenAddress);
  return `${formatTokenAmount(rawAmount, info.decimals)} ${label}`;
}

function formatTokenAmount(rawAmount, decimals) {
  if (rawAmount === null || rawAmount === undefined || rawAmount === "") return "?";
  let bi;
  try {
    bi = BigInt(rawAmount);
  } catch {
    return String(rawAmount);
  }
  if (decimals === 0) return bi.toString();
  const negative = bi < 0n;
  if (negative) bi = -bi;
  const divisor = 10n ** BigInt(decimals);
  const whole = (bi / divisor).toString();
  const fracRaw = (bi % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  const formatted = fracRaw.length === 0 ? whole : `${whole}.${fracRaw}`;
  return negative ? `-${formatted}` : formatted;
}

function helpText() {
  const lines = [
    `Budokan tournament bot (chain: ${currentChain})`,
    "",
    "This bot shows tournaments and posts live updates. To actually play —",
    "connect, enter, submit scores, claim — you sign in a private chat with",
    config.playBotUsername
      ? `@${config.playBotUsername}. Use /connect to open it.`
      : "the Budokan web app (this bot is read-only).",
    "",
    "Browse:",
    "/tournaments [phase] - list recent tournaments (optional phase filter)",
    "/tournament <id> - show tournament details",
    "/leaderboard <id> - show leaderboard (top 20)",
    "/prizes <id> - show prizes grouped by pool, with claim status",
    "",
    "Follow:",
    "/follow <tournamentId> - subscribe this chat to live updates for a tournament",
    "/unfollow <tournamentId> - stop one tournament",
    "/unfollow - stop all tournaments in this chat",
    "/following - list followed tournaments on the current chain",
    "",
    "Play (hands off to the play bot in DM):",
    "/connect - connect your wallet to start playing",
    "/play <id> - get options to enter or play (in Telegram or browser)",
    "/claim <id> - get options to claim rewards (in Telegram or browser)",
    "/create - create a tournament",
    "",
    `/chain [${SUPPORTED_CHAINS.join("|")}] - show or switch the active chain`,
  ];
  return lines.join("\n");
}

// Register the "/" autocomplete menu so users see the available commands.
// Best-effort: a failure here (e.g. transient Telegram error) should not stop
// the bot from running. Descriptions adapt to whether a play bot is wired up.
async function registerCommandMenu() {
  const playDesc = config.playBotUsername
    ? "Enter or play (in Telegram or browser)"
    : "Get a link to enter or play";
  const claimDesc = config.playBotUsername
    ? "Claim rewards (in Telegram or browser)"
    : "Get a link to claim rewards";
  const commands = [
    { command: "help", description: "Show command list" },
    { command: "tournaments", description: "List recent tournaments" },
    { command: "tournament", description: "Show tournament details" },
    { command: "leaderboard", description: "Show the top 20 leaderboard" },
    { command: "prizes", description: "List posted prizes" },
    { command: "connect", description: "Connect your wallet to start playing (opens the play bot)" },
    { command: "play", description: playDesc },
    { command: "claim", description: claimDesc },
    { command: "create", description: "Create a tournament (opens the play bot)" },
    { command: "follow", description: "Get live updates for a tournament" },
    { command: "unfollow", description: "Stop following a tournament" },
    { command: "following", description: "List followed tournaments" },
    { command: "chain", description: "Show or switch the active chain" },
  ];
  try {
    await telegram("setMyCommands", { commands });
  } catch (error) {
    console.error("setMyCommands failed:", formatError(error));
  }
}

function tournamentUrl(tournamentId) {
  // Include the active chain — without ?network the site defaults to mainnet,
  // sending sepolia users to the wrong (or nonexistent) tournament.
  return `${config.webUrl}/tournament/${tournamentId}?network=${currentChain}`;
}

// Telegram deep link into a 1:1 chat with the companion controller bot.
// Tapping it opens that bot and sends `/start <payload>`, which the controller
// bot parses to resume the flow (see its telegram.ts handleStart()). The start
// payload is restricted to [A-Za-z0-9_-]; action/id/chain all qualify.
//   - with an id:    `<action>_<id>_<chain>`  (enter / claim)
//   - without an id: `<action>_<chain>`       (connect / create)
function playBotDeepLink(action, tournamentId) {
  const payload =
    tournamentId === undefined || tournamentId === null
      ? `${action}_${currentChain}`
      : `${action}_${tournamentId}_${currentChain}`;
  return `https://t.me/${config.playBotUsername}?start=${payload}`;
}

// Build the /play and /claim response. Presents both paths when a play bot is
// configured (in-Telegram first, since it's the nicer UX), otherwise just the
// browser link — so the bot is still useful deployed on its own.
function handoffMessage(action, tournamentId) {
  const webLine =
    action === "claim"
      ? `Claim rewards on Budokan, signing in the browser with your Cartridge wallet:\n${tournamentUrl(tournamentId)}`
      : `Enter or play on Budokan, signing in the browser with your Cartridge wallet:\n${tournamentUrl(tournamentId)}`;

  if (!config.playBotUsername) {
    return webLine;
  }

  const verb = action === "claim" ? "claim rewards for" : "enter or play";
  return [
    `🎮 Tournament #${tournamentId} — two ways to ${action === "claim" ? "claim" : "play"}:`,
    "",
    "▶ In Telegram (recommended)",
    `Connect once with @${config.playBotUsername}, then ${verb} right here in chat — no browser:`,
    playBotDeepLink(action, tournamentId),
    "",
    "🌐 In your browser",
    webLine,
  ].join("\n");
}

// /connect in this read-only bot can't sign anything — point the user at the
// DM signer bot, where connecting actually happens. Without a play bot wired
// up, fall back to the Budokan web app.
async function sendConnectLink(chatId) {
  if (!config.playBotUsername) {
    await sendMessage(
      chatId,
      `This bot is read-only and can't connect a wallet.\nConnect and play on Budokan instead:\n${config.webUrl}`,
    );
    return;
  }
  await sendMessage(
    chatId,
    [
      "🔑 Connecting happens in a private chat with the play bot, where your wallet stays secure.",
      `Tap to open @${config.playBotUsername} and connect:`,
      playBotDeepLink("connect"),
      "",
      "Once connected there, you can enter, submit scores, and claim — all in chat.",
    ].join("\n"),
  );
}

// /create likewise redirects to the DM signer bot (creating a tournament is a
// signed action this read-only bot can't perform).
async function sendCreateLink(chatId) {
  if (!config.playBotUsername) {
    await sendMessage(
      chatId,
      `This bot is read-only and can't create tournaments.\nCreate one on Budokan instead:\n${config.webUrl}`,
    );
    return;
  }
  await sendMessage(
    chatId,
    [
      "🏗️ Creating a tournament is a signed action — it happens in a private chat with the play bot.",
      `Tap to open @${config.playBotUsername} and start:`,
      playBotDeepLink("create"),
    ].join("\n"),
  );
}

function normalizeTournamentId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  // Tournament ids are decimal in the API and contracts. Reject anything else.
  if (!/^[0-9]+$/.test(trimmed)) return "";
  return trimmed;
}

function normalizePhase(value) {
  if (typeof value !== "string") return undefined;
  const lower = value.toLowerCase();
  const valid = new Set(["scheduled", "registration", "staging", "live", "submission", "finalized"]);
  return valid.has(lower) ? lower : undefined;
}

// Provided for parity with the denshokan example — exported but unused inside
// the bot today because no command takes an account address. Kept here so
// downstream forks can add account-aware features without re-importing.
function _normalizeAddress(value) {
  if (typeof value !== "string" || !/^0[xX][0-9a-fA-F]+$/.test(value)) {
    throw new Error("Invalid address");
  }
  return normalizeSdkAddress(value.toLowerCase());
}

function shortHex(value) {
  if (!value || typeof value !== "string" || value.length <= 18) return value || "";
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function formatTimestamp(value) {
  if (!value) return "?";
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return String(value);
  return new Date(seconds * 1000).toISOString();
}

function formatTimeRange(start, end) {
  return `${formatTimestamp(start)} → ${formatTimestamp(end)}`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function telegram(method, body, options = {}) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `Telegram ${method} failed`);
  }
  return payload.result;
}

async function sendMessage(chatId, text) {
  for (const chunk of splitForTelegram(text)) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
}

function splitForTelegram(text) {
  if (typeof text !== "string" || text.length <= TELEGRAM_CHUNK_LIMIT) {
    return [text];
  }
  const lines = text.split("\n");
  const chunks = [];
  let buffer = "";
  for (const line of lines) {
    if (line.length > TELEGRAM_CHUNK_LIMIT) {
      // Single line exceeds the limit — flush the buffer and hard-cut the
      // line into limit-sized slices.
      if (buffer) { chunks.push(buffer); buffer = ""; }
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

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cleanup);
      resolve();
    };
    timeout = setTimeout(cleanup, ms);
    signal?.addEventListener("abort", cleanup, { once: true });
  });
}

function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("Shutting down...");
  telegramPollingAbortController.abort();
  if (unsubscribeBudokan) unsubscribeBudokan();
  // `destroy()` also tears down SDK health monitoring. Use it only for final
  // process shutdown, not as a temporary pause/resume mechanism.
  client.destroy();
}
