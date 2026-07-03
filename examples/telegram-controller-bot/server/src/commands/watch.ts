// Tournament lifecycle broadcaster + /follow family.
//
// The bot posts a card to a public channel each time a watched tournament
// crosses a lifecycle edge: entry opens → games live → games over (submit
// scores) → finalized (claim). Those edges are time-driven — the contract has
// no event for "the clock reached game start" — so we POLL: tournamentTick()
// runs on an interval (see index.ts), reads each watched tournament, and diffs
// its phase against the last-announced snapshot in TournamentWatchStore.
//
// Prize additions and score submissions are event-driven and stream over the
// SDK `prizes` / `submissions` WS channels (see tournament-watch-ws.ts) when the
// runtime supports it; this poller carries the same two as a count-diff fallback
// (gated by the opts flags) for runtimes without a global WebSocket.
//
// At finalize the poller also posts a WINNER card (top finishers within the
// prize spots, with amounts) and then keeps watching — draining reward claims
// until everything is claimed (→ "all rewards distributed" card) or a 14-day cap
// expires. A send that Telegram rejects as a dead chat (bot kicked / chat gone)
// drops the watch so it stops retrying forever.
//
// Tournaments enter the watch list automatically from /create, or manually via
// /follow <id>.

import {
  createBudokanClient,
  getDistributableRewards,
  tournamentPageUrl,
  type Tournament,
  type ClaimableReward,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient } from "@provable-games/denshokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import type { TelegramApi } from "../telegram-api.ts";
import type { InlineKeyboardButton } from "../telegram-api.ts";
import type { TournamentWatchStore, WatchedTournament } from "../tournament-watch-store.ts";
import { readAnnounceChannel } from "../bracket-store.ts";
import { fetchAllRewardClaims } from "../reward-claims.ts";
import { findKnownToken } from "../catalog/tokens.ts";
import { formatTokenAmount } from "../format.ts";
import { formatError } from "../format-error.ts";
import { CHAINS, normalizeAddress } from "@provable-games/budokan-sdk";

/** Keep watching a finalized tournament this long to catch late claims. */
const FINALIZED_RETENTION_SECONDS = 14 * 24 * 60 * 60;

function sdkClient(config: Config, chain: Chain) {
  return createBudokanClient({
    chain,
    ...(config.apiUrl ? { apiBaseUrl: config.apiUrl } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.budokanAddress ? { budokanAddress: config.budokanAddress } : {}),
    ...(config.viewerAddress ? { viewerAddress: config.viewerAddress } : {}),
  } as Parameters<typeof createBudokanClient>[0]);
}

/**
 * Register a tournament for channel lifecycle broadcasts. Called by /create
 * (right after it posts the "new tournament" card) and by /follow. Seeds the
 * snapshot from the current state so we announce forward edges, not the state
 * it was already in when first watched.
 */
export async function addWatch(
  config: Config,
  store: TournamentWatchStore,
  chain: Chain,
  tournamentId: string,
  announceChatId: string,
  seed?: Tournament,
): Promise<void> {
  const t = seed ?? (await sdkClient(config, chain).getTournament(tournamentId).catch(() => null));
  await store.save({
    tournamentId,
    chain,
    announceChatId,
    name: t?.name || undefined,
    lastPhase: t ? derivePhase(t, nowSec()) ?? undefined : undefined,
    lastPrizeCount: t?.prizeCount ?? 0,
    lastSubmissionCount: t?.submissionCount ?? 0,
  });
}

/**
 * Current lifecycle phase from the tournament's absolute boundary timestamps.
 * We derive it here rather than trusting `Tournament.phase`: that field is
 * computed from `createdAtOnchain`, which the API read path doesn't always
 * populate (it comes back null), whereas the absolute times below are always
 * present for a scheduled tournament. Order mirrors the contract's
 * `current_phase`: scheduled → registration → staging → live → submission →
 * finalized. Registration / submission windows are optional (null when absent).
 */
export function derivePhase(t: Tournament, now: number): string | null {
  const regStart = num(t.registrationStartTime);
  const regEnd = num(t.registrationEndTime);
  const gameStart = num(t.gameStartTime);
  const gameEnd = num(t.gameEndTime);
  const subEnd = num(t.submissionEndTime);
  if (gameStart === null || gameEnd === null) return null; // not enough to place it
  if (regStart !== null && now < regStart) return "scheduled";
  if (regEnd !== null && now < regEnd) return "registration";
  if (now < gameStart) return "staging";
  if (now < gameEnd) return "live";
  if (subEnd !== null && now < subEnd) return "submission";
  return "finalized";
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ----- poller -----

/** Phases we post a card for, and the card each produces. Order matters only
 *  for readability; the diff fires on any change into one of these. */
const PHASE_CARDS: Record<string, (name: string) => string> = {
  registration: (n) => `📝 Entry is open for ${n} — enter now!`,
  live: (n) => `🟢 ${n} is live — play your game now!`,
  submission: (n) => `⏹️ ${n}'s games are over — submit your scores so the leaderboard settles.`,
  finalized: (n) => `🏁 ${n} is finalized — winners can claim their rewards.`,
};

export interface TickOptions {
  /** WS handles submissions — don't also count-diff them here. */
  skipSubmissionCards?: boolean;
  /** WS handles prize additions — don't also count-diff them here. */
  skipPrizeCards?: boolean;
}

/** Runs every tick from index.ts. Best-effort per tournament — one failure
 *  never blocks the rest. */
export async function tournamentTick(
  api: TelegramApi,
  config: Config,
  store: TournamentWatchStore,
  opts: TickOptions = {},
): Promise<void> {
  let watched: WatchedTournament[];
  try {
    watched = await store.all();
  } catch (error) {
    console.error("tournamentTick: list failed:", formatError(error));
    return;
  }
  for (const w of watched) {
    try {
      await tickOne(api, config, store, w, opts);
    } catch (error) {
      console.error(`tournamentTick: ${w.chain}/${w.tournamentId} failed:`, formatError(error));
    }
  }
}

async function tickOne(
  api: TelegramApi,
  config: Config,
  store: TournamentWatchStore,
  w: WatchedTournament,
  opts: TickOptions,
): Promise<void> {
  const client = sdkClient(config, w.chain);
  const t = await client.getTournament(w.tournamentId);
  if (!t) return; // transient read miss — retry next tick, keep the snapshot

  const name = t.name || w.name || `Tournament #${w.tournamentId}`;
  const phase = derivePhase(t, nowSec()) ?? undefined;
  const prizeCount = t.prizeCount ?? 0;
  const submissionCount = t.submissionCount ?? 0;
  const url = tournamentPageUrl(w.chain, w.tournamentId);
  const enteringFinalized = phase === "finalized" && w.lastPhase !== "finalized";

  const cards: string[] = [];

  // Phase edge — announce the state it's now IN (so a bot that was down across
  // several edges still posts the current one, not a stale intermediate).
  if (phase && phase !== w.lastPhase && PHASE_CARDS[phase]) {
    cards.push(`${PHASE_CARDS[phase]!(name)}\n🔗 ${url}`);
  }
  // Winner card once, at the finalize edge: top finishers within the prize
  // spots, with the amount each won. Best-effort — null if unavailable.
  if (enteringFinalized) {
    const winners = await buildWinnerCard(config, w.chain, t).catch(() => null);
    if (winners) cards.push(`${winners}\n🔗 ${url}`);
  }

  // Event-driven counts. Only announce increases (a re-index could briefly
  // report fewer; don't spam a "prize removed" card off that). Each is skipped
  // when its WS channel is handling it (the snapshot still advances so a later
  // WS outage doesn't replay a backlog).
  if (
    !opts.skipPrizeCards &&
    w.lastPrizeCount !== undefined &&
    prizeCount > w.lastPrizeCount
  ) {
    const added = prizeCount - w.lastPrizeCount;
    cards.push(`🏆 ${added} new prize${added === 1 ? "" : "s"} added to ${name}.\n🔗 ${url}`);
  }
  if (
    !opts.skipSubmissionCards &&
    w.lastSubmissionCount !== undefined &&
    submissionCount > w.lastSubmissionCount
  ) {
    const added = submissionCount - w.lastSubmissionCount;
    cards.push(`📥 ${added} new score${added === 1 ? "" : "s"} submitted in ${name}.`);
  }

  for (const text of cards) {
    if ((await postCard(api, w, text, url)) === "dead") {
      await dropDeadWatch(store, w);
      return;
    }
  }

  // Post-finalize: keep watching to drain claims. Once every reward is claimed,
  // post the wrap-up card and drop; otherwise drop after the retention cap.
  const finalizedAt = w.finalizedAt ?? (phase === "finalized" ? nowSec() : undefined);
  if (phase === "finalized") {
    const summary = await client.getTournamentRewardClaimsSummary(w.tournamentId).catch(() => null);
    if (summary && summary.totalPrizes > 0 && summary.totalUnclaimed === 0) {
      if ((await postCard(api, w, `🏁 All rewards distributed in ${name}.`, url)) === "dead") {
        await dropDeadWatch(store, w);
      } else {
        await store.delete(w.chain, w.tournamentId).catch(() => {});
      }
      return;
    }
    if (finalizedAt !== undefined && nowSec() - finalizedAt > FINALIZED_RETENTION_SECONDS) {
      await store.delete(w.chain, w.tournamentId).catch(() => {});
      return;
    }
  }

  await store.save({
    ...w,
    name,
    lastPhase: phase,
    lastPrizeCount: prizeCount,
    lastSubmissionCount: submissionCount,
    finalizedAt,
  });
}

/**
 * Winner card for a just-finalized tournament: the top finishers *within the
 * prize spots* (max 3), each with the amount they won. Returns null when there
 * are no prize spots, no scored entrants, or the data can't be read.
 */
async function buildWinnerCard(config: Config, chain: Chain, t: Tournament): Promise<string | null> {
  const spots = t.paidPlaces ?? 0;
  if (spots <= 0) return null;
  const topN = Math.min(3, spots);

  const budokan = config.budokanAddress ?? CHAINS[chain]?.budokanAddress;
  if (!budokan) return null;

  // Ranked entrants — denshokan tokens carry score + playerName + owner.
  let winners: Array<{ owner: string; playerName: string | null; score: number }>;
  try {
    const denshokan = createDenshokanClient({ chain } as Parameters<typeof createDenshokanClient>[0]);
    const res = await denshokan.getTokens({
      minterAddress: normalizeAddress(budokan),
      contextId: Number(t.id),
      sort: { field: "score", direction: t.leaderboardAscending ? "asc" : "desc" },
      limit: Math.max(topN * 4, 12),
    });
    winners = res.data.filter((x) => x.score > 0 || x.gameOver).slice(0, topN);
  } catch {
    return null;
  }
  if (winners.length === 0) return null;

  // Amount won per position (best-effort — names-only if this read fails).
  let amountByPos = new Map<number, string>();
  try {
    const client = sdkClient(config, chain);
    const [prizes, claims] = await Promise.all([
      client.getTournamentPrizes(t.id),
      fetchAllRewardClaims(client, t.id),
    ]);
    amountByPos = winningsByPosition(chain, getDistributableRewards({ tournament: t, prizes, existingClaims: claims }));
  } catch {
    // leave amounts empty
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = [`🏆 ${t.name || `#${t.id}`} — final results:`];
  winners.forEach((wn, i) => {
    const who = wn.playerName?.trim() || shortAddr(wn.owner);
    const won = amountByPos.get(i + 1);
    lines.push(`${medals[i] ?? `#${i + 1}`} ${who}${won ? ` — won ${won}` : ""}`);
  });
  return lines.join("\n");
}

/** Sum ERC-20 position winnings per leaderboard position, formatted per token. */
function winningsByPosition(chain: Chain, rewards: ClaimableReward[]): Map<number, string> {
  const POSITION_SOURCES = new Set(["entry_fee_position", "sponsor_single", "sponsor_distributed"]);
  const byPos = new Map<number, Map<string, bigint>>();
  for (const r of rewards) {
    if (!POSITION_SOURCES.has(r.source)) continue;
    if (r.tokenType !== "erc20" || r.amount === undefined || !r.tokenAddress) continue;
    const toks = byPos.get(r.position) ?? new Map<string, bigint>();
    toks.set(r.tokenAddress, (toks.get(r.tokenAddress) ?? 0n) + r.amount);
    byPos.set(r.position, toks);
  }
  const out = new Map<number, string>();
  for (const [pos, toks] of byPos) {
    const parts: string[] = [];
    for (const [addr, amt] of toks) {
      const known = findKnownToken(chain, addr);
      parts.push(known ? `${formatTokenAmount(amt.toString(), known.decimals)} ${known.symbol}` : `${amt} (${shortAddr(addr)})`);
    }
    if (parts.length) out.set(pos, parts.join(" + "));
  }
  return out;
}

type PostResult = "ok" | "dead" | "error";

/** Send a card; report whether the announce chat is permanently unreachable. */
async function postCard(
  api: TelegramApi,
  w: WatchedTournament,
  text: string,
  url: string,
): Promise<PostResult> {
  try {
    await api.sendMessage(w.announceChatId, text, { replyMarkup: pageButton(url) });
    return "ok";
  } catch (error) {
    return isDeadChat(error) ? "dead" : "error";
  }
}

async function dropDeadWatch(store: TournamentWatchStore, w: WatchedTournament): Promise<void> {
  await store.delete(w.chain, w.tournamentId).catch(() => {});
  console.log(`watch: dropped ${w.chain}/${w.tournamentId} — announce chat ${w.announceChatId} unreachable.`);
}

/** Telegram errors that mean the announce chat is gone / the bot can't post there. */
export function isDeadChat(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes("chat not found") ||
    msg.includes("bot was blocked") ||
    msg.includes("bot was kicked") ||
    msg.includes("bot is not a member") ||
    msg.includes("not enough rights") ||
    msg.includes("have no rights to send") ||
    msg.includes("chat_write_forbidden") ||
    msg.includes("group chat was deactivated") ||
    msg.includes("chat was upgraded")
  );
}

function pageButton(url: string): { inline_keyboard: InlineKeyboardButton[][] } {
  return { inline_keyboard: [[{ text: "budokan.gg", url }]] };
}

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

// ----- /follow, /unfollow, /following -----

export async function follow(
  api: TelegramApi,
  config: Config,
  store: TournamentWatchStore,
  chatId: string,
  chain: Chain,
  args: string[],
): Promise<void> {
  const id = args[0]?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await api.sendMessage(chatId, "Usage: /follow <tournamentId> — I'll post its live/submission/finalized updates to the channel.");
    return;
  }
  const t = await sdkClient(config, chain).getTournament(id).catch(() => null);
  if (!t) {
    await api.sendMessage(chatId, `Couldn't find tournament #${id} on ${chain}. Check the id and your /chain.`);
    return;
  }
  if (derivePhase(t, nowSec()) === "finalized") {
    await api.sendMessage(chatId, `Tournament #${id} is already finalized — nothing left to broadcast.`);
    return;
  }
  // Post updates to the configured channel if there is one; otherwise here.
  const announce = (await readAnnounceChannel(config.dataDir)) ?? chatId;
  await addWatch(config, store, chain, id, announce, t);
  const name = t.name || `#${id}`;
  const where = announce === chatId ? "here" : "in the announce channel";
  await api.sendMessage(
    chatId,
    `👀 Following ${name} (#${id}) on ${chain}. I'll post live / submission / finalized updates ${where}.`,
  );
}

export async function unfollow(
  api: TelegramApi,
  store: TournamentWatchStore,
  chatId: string,
  chain: Chain,
  args: string[],
): Promise<void> {
  const id = args[0]?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await api.sendMessage(chatId, "Usage: /unfollow <tournamentId>");
    return;
  }
  const existing = await store.get(chain, id);
  await store.delete(chain, id);
  await api.sendMessage(
    chatId,
    existing ? `🚫 Stopped following #${id} on ${chain}.` : `Wasn't following #${id} on ${chain}.`,
  );
}

export async function following(
  api: TelegramApi,
  store: TournamentWatchStore,
  chatId: string,
  chain: Chain,
): Promise<void> {
  const all = (await store.all()).filter((w) => w.chain === chain);
  if (all.length === 0) {
    await api.sendMessage(chatId, `Not following any tournaments on ${chain}. Add one with /follow <id>.`);
    return;
  }
  const lines = all.map((w) => {
    const name = w.name ?? `Tournament`;
    return `• ${name} (#${w.tournamentId}) — ${w.lastPhase ?? "?"}`;
  });
  await api.sendMessage(chatId, [`👀 Following on ${chain}:`, ...lines].join("\n"));
}
