// /bracket — organizer flow to create + run an off-chain 1v1 single-elim
// bracket over Budokan tournaments, with on-chain gating (each round's entry
// requires having won the feeder match). The whole tree is deployed up front;
// the bot enters round-1 players on their behalf and, as rounds resolve, enters
// the winners into the next gated match. See budokan-sdk `src/brackets`.
//
// Multi-turn create flow (DM, organizer-only — the connected wallet pays the
// gas, all paymastered): game → players → match length → optional prize →
// confirm → deploy. Progression is handled by the poller (advanceStoredBracket).

import {
  CHAINS,
  createBudokanClient,
  createBracket,
  advanceBracket,
  attachMatchTournament,
  bracketEntryCalls,
  bracketFinalPrizeCalls,
  bracketRounds,
  bracketSummary,
  parseTournamentIdFromReceipt,
  roundMatchCreateCalls,
  tournamentPageUrl,
  explorerTxUrl,
  type BracketState,
  type MatchReader,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient } from "@provable-games/denshokan-sdk";
import { RpcProvider } from "starknet";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import { TelegramApi } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { keychainSafeRpcUrl } from "../cartridge-link.ts";
import { gamesForChain, type Game } from "../catalog/games.ts";
import { tokensForChain } from "../catalog/tokens.ts";
import { formatError } from "../format-error.ts";
import { BracketStore, type StoredBracket } from "../bracket-store.ts";

// Per-match schedule presets (durations in seconds). registration opens at
// creation; the game starts when registration closes; then a submission window.
const LENGTH_PRESETS = [
  { label: "Quick — 15m registration, 30m game", reg: 900, game: 1800, sub: 900 },
  { label: "Standard — 1h registration, 6h game", reg: 3600, game: 21600, sub: 3600 },
  { label: "Daily — 6h registration, 24h game", reg: 21600, game: 86400, sub: 21600 },
] as const;

interface Draft {
  step: "game" | "players" | "length" | "prize" | "confirm";
  chain: Chain;
  games: Game[];
  game?: Game;
  players?: Array<{ address: string; name?: string }>;
  length?: (typeof LENGTH_PRESETS)[number];
  prize?: { tokenAddress: string; amount: string; label: string };
}

const drafts = new Map<string, Draft>();

export function isPending(chatId: string): boolean {
  return drafts.has(chatId);
}
export function cancel(chatId: string): boolean {
  return drafts.delete(chatId);
}

// ----- create flow -----

export async function start(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
): Promise<void> {
  const session = await resolveAccount(chatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(chatId, `Not connected on ${chain} — run /connect first (the organizer wallet creates the matches).`);
    return;
  }
  const games = await gamesForChain(chain);
  if (games.length === 0) {
    await api.sendMessage(chatId, `No games available on ${chain}.`);
    return;
  }
  drafts.set(chatId, { step: "game", chain, games });
  const lines = [`🏗️ New bracket on ${chain} — pick a game:`, ""];
  games.forEach((g, i) => lines.push(`  ${i + 1}. ${g.name}`));
  lines.push("", "Reply with a number. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

export async function handleAnswer(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  text: string,
): Promise<void> {
  const d = drafts.get(chatId);
  if (!d) return;
  const t = text.trim();

  if (d.step === "game") {
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > d.games.length) {
      await api.sendMessage(chatId, `Reply 1–${d.games.length}, or /cancel.`);
      return;
    }
    d.game = d.games[n - 1];
    d.step = "players";
    await api.sendMessage(
      chatId,
      [
        `🎮 ${d.game!.name}.`,
        "",
        "Now paste the players — one per line, `address optional-name`:",
        "```",
        "0x123… alice",
        "0x456… bob",
        "```",
        "Count must be a power of two (2, 4, 8, 16…) — gated brackets can't have byes.",
      ].join("\n"),
    );
    return;
  }

  if (d.step === "players") {
    const players: Array<{ address: string; name?: string }> = [];
    for (const line of t.split(/\n+/)) {
      const parts = line.trim().split(/\s+/);
      const address = parts[0];
      if (!address) continue;
      if (!/^0x[0-9a-fA-F]+$/.test(address)) {
        await api.sendMessage(chatId, `"${address}" isn't a 0x address. Fix the list and resend, or /cancel.`);
        return;
      }
      players.push({ address, name: parts.slice(1).join(" ") || undefined });
    }
    const isPow2 = players.length >= 2 && (players.length & (players.length - 1)) === 0;
    if (!isPow2) {
      await api.sendMessage(chatId, `Got ${players.length} players. Need a power of two (2, 4, 8, 16…). Resend, or /cancel.`);
      return;
    }
    d.players = players;
    d.step = "length";
    const lines = [`👥 ${players.length} players. Pick a match length:`, ""];
    LENGTH_PRESETS.forEach((p, i) => lines.push(`  ${i + 1}. ${p.label}`));
    lines.push("", "Reply with a number. /cancel to abort.");
    await api.sendMessage(chatId, lines.join("\n"));
    return;
  }

  if (d.step === "length") {
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > LENGTH_PRESETS.length) {
      await api.sendMessage(chatId, `Reply 1–${LENGTH_PRESETS.length}, or /cancel.`);
      return;
    }
    d.length = LENGTH_PRESETS[n - 1];
    d.step = "prize";
    await api.sendMessage(
      chatId,
      [
        "🏆 Champion prize? Reply `<symbol> <amount>` (e.g. `STRK 100`) to escrow an ERC-20 on the final match,",
        "or `skip` for bragging rights only. /cancel to abort.",
      ].join("\n"),
    );
    return;
  }

  if (d.step === "prize") {
    if (t.toLowerCase() !== "skip") {
      const [sym, amt] = t.split(/\s+/);
      const token = sym ? findTokenBySymbol(d.chain, sym) : undefined;
      if (!token || !amt || !/^\d+(\.\d+)?$/.test(amt)) {
        await api.sendMessage(chatId, "Couldn't parse that. Use `<symbol> <amount>` (known token), or `skip`.");
        return;
      }
      const raw = toRawAmount(amt, token.decimals);
      d.prize = { tokenAddress: token.address, amount: raw, label: `${amt} ${token.symbol}` };
    }
    d.step = "confirm";
    await api.sendMessage(chatId, confirmText(d));
    return;
  }

  if (d.step === "confirm") {
    if (t.toLowerCase() !== "yes") {
      await api.sendMessage(chatId, "Reply 'yes' to deploy, or /cancel.");
      return;
    }
    drafts.delete(chatId);
    await deployBracket(api, config, store, chatId, d);
    return;
  }
}

function confirmText(d: Draft): string {
  return [
    "🧾 Confirm bracket:",
    `  • Game: ${d.game!.name}`,
    `  • Players: ${d.players!.length}`,
    `  • Match length: ${d.length!.label}`,
    `  • Champion prize: ${d.prize ? d.prize.label : "none"}`,
    "",
    "This deploys every match tournament up front (gated so each round needs a",
    "win in the previous one) and enters round 1 on the players' behalf.",
    "",
    "Reply 'yes' to deploy, or /cancel.",
  ].join("\n");
}

// ----- deploy -----

async function deployBracket(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  d: Draft,
): Promise<void> {
  const chain = d.chain;
  const session = await resolveAccount(chatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(chatId, `Not connected on ${chain} — run /connect first.`);
    return;
  }
  const budokanAddress = config.budokanAddress ?? CHAINS[chain]?.budokanAddress;
  if (!budokanAddress) {
    await api.sendMessage(chatId, `Internal error: no Budokan address for ${chain}.`);
    return;
  }

  const id = `b${Date.now().toString(36)}`;
  const game = d.game!;
  const state = createBracket({
    id,
    budokanAddress,
    game: game.contractAddress,
    chain: chain as BracketState["chain"],
    settingsId: 0,
    creatorRewardsAddress: session.data.address,
    namePrefix: game.name.slice(0, 12),
    scheduleTemplate: {
      registrationStartDelay: 0,
      registrationEndDelay: d.length!.reg,
      gameStartDelay: d.length!.reg,
      gameEndDelay: d.length!.game,
      submissionDuration: d.length!.sub,
    },
    leaderboard: {
      ascending: game.leaderboardAscending ?? false,
      gameMustBeOver: game.leaderboardGameMustBeOver ?? false,
    },
    players: d.players!,
    gated: true,
    finalPrize: d.prize ? { tokenAddress: d.prize.tokenAddress, amount: d.prize.amount } : undefined,
  });

  const announceChatId = config.bracketChannelId ?? chatId;
  const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(chain, config.rpcUrl) });
  await api.sendMessage(chatId, `⏳ Deploying ${bracketRounds(state)} rounds of match tournaments… this takes a moment.`);

  // Deploy round by round so each round's gating can reference the prior round's
  // tournament ids.
  try {
    for (let round = 1; round <= bracketRounds(state); round++) {
      for (const { matchId, call } of roundMatchCreateCalls(state, round)) {
        const tx = await session.data.account.execute([call]);
        const receipt = (await rpc.waitForTransaction(tx.transaction_hash)) as {
          events?: Array<{ from_address?: string; keys?: string[] }>;
        };
        const tid = parseTournamentIdFromReceipt(receipt, budokanAddress);
        if (tid === undefined) throw new Error(`Couldn't read tournament id for ${matchId}`);
        attachMatchTournament(state, matchId, tid.toString());
      }
      await store.save({ state, organizerChatId: chatId, announceChatId });
    }

    // Enter round-1 players on their behalf (round 1 is ungated).
    for (const m of state.matches.filter((x) => x.round === 1 && x.tournamentId)) {
      for (const p of [m.playerA, m.playerB]) {
        if (!p) continue;
        await session.data.account.execute(bracketEntryCalls(state, m.id, p.address));
      }
    }

    // Escrow the champion prize on the final, if any.
    const prizeCalls = bracketFinalPrizeCalls(state);
    if (prizeCalls.length > 0) {
      await session.data.account.execute(prizeCalls);
    }
  } catch (error) {
    await store.save({ state, organizerChatId: chatId, announceChatId }).catch(() => {});
    await api.sendMessage(
      chatId,
      `❌ Deploy stopped: ${formatError(error)}\nProgress was saved — /brackets shows what's live so far.`,
    );
    return;
  }

  await store.save({ state, organizerChatId: chatId, announceChatId });
  await api.sendMessage(chatId, `✅ Bracket ${id} deployed. Round 1 is live and players are entered.`);
  await announce(api, { state, organizerChatId: chatId, announceChatId }, "🥊 A new bracket has started!");
}

// ----- advancement (poller) -----

/**
 * Resolve finished matches and enter the winners into their gated next match.
 * Called on an interval by the poller. Returns true if anything changed (so the
 * caller can persist + announce).
 */
export async function advanceStoredBracket(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  b: StoredBracket,
): Promise<void> {
  const chain = b.state.chain as Chain;
  const session = await resolveAccount(b.organizerChatId, chain, config);
  if (!session.ok) return; // organizer session lapsed; skip until reconnected

  const before = bracketSummary(b.state);
  const read = buildReader(config, chain);

  // 1. Resolve any finished live matches (advanceBracket is pure w.r.t. chain).
  const { state } = await advanceBracket(b.state, read);
  b.state = state;

  // 2. Enter winners into gated next-round matches that are now ready and that
  //    we haven't entered yet. Track entered match ids to stay idempotent.
  const entered = new Set<string>(b.entered ?? []);
  for (const m of state.matches) {
    if (m.round === 1 || !m.tournamentId) continue;
    if (entered.has(m.id)) continue;
    if (!m.playerA || !m.playerB) continue; // both feeders not resolved yet
    try {
      for (const p of [m.playerA, m.playerB]) {
        await session.data.account.execute(bracketEntryCalls(state, m.id, p.address));
      }
      entered.add(m.id);
    } catch (error) {
      // A feeder may not be resolved-with-token yet, or the window isn't open.
      // Leave it for the next tick.
      console.error(`bracket ${state.id} enter ${m.id} failed:`, formatError(error));
    }
  }
  b.entered = [...entered];

  await store.save(b);

  // 3. Announce if the tree changed (a match resolved or a champion crowned).
  if (bracketSummary(b.state) !== before) {
    const header = b.state.status === "complete" ? "🏆 Bracket complete!" : "📣 Bracket update";
    await announce(api, b, header);
  }
}

/** A MatchReader: leaderboard → addresses (+ winning token), finished-by-time. */
function buildReader(config: Config, chain: Chain): MatchReader {
  const client = createBudokanClient({
    chain,
    ...(config.apiUrl ? { apiBaseUrl: config.apiUrl } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.budokanAddress ? { budokanAddress: config.budokanAddress } : {}),
    ...(config.viewerAddress ? { viewerAddress: config.viewerAddress } : {}),
  } as Parameters<typeof createBudokanClient>[0]);
  const denshokan = createDenshokanClient({ chain });

  return async (tournamentId: string) => {
    const tournament = await client.getTournament(tournamentId);
    const now = Math.floor(Date.now() / 1000);
    const gameEnd = Number(tournament?.gameEndTime ?? 0);
    const finished = gameEnd > 0 && now >= gameEnd;
    if (!finished) return { finished: false, ranking: [] };

    const lb = await client.getTournamentLeaderboard(tournamentId);
    const ranking: Array<{ address: string; position: number; tokenId?: string }> = [];
    for (const e of lb) {
      let owner = "";
      try {
        owner = (await denshokan.getToken(e.tokenId)).owner ?? "";
      } catch {
        // unknown owner — skip; resolveWinner falls back to seed on a miss
      }
      if (owner) ranking.push({ address: owner, position: e.position, tokenId: e.tokenId });
    }
    return { finished: true, ranking };
  };
}

// ----- /brackets list + presentation -----

export async function list(
  api: TelegramApi,
  store: BracketStore,
  chatId: string,
  chain: Chain,
): Promise<void> {
  const all = (await store.all()).filter((b) => (b.state.chain as Chain) === chain);
  if (all.length === 0) {
    await api.sendMessage(chatId, `No brackets on ${chain}. Create one with /bracket.`);
    return;
  }
  const lines = [`🥊 Brackets on ${chain}:`, ""];
  for (const b of all) {
    const champ = b.state.champion ? ` — 🏆 ${b.state.champion.name ?? short(b.state.champion.address)}` : "";
    lines.push(`  • ${b.state.id} [${b.state.status}] · ${b.state.players.length} players${champ}`);
  }
  lines.push("", "Send /bracket_view <id> to see the tree.");
  await api.sendMessage(chatId, lines.join("\n"));
}

export async function view(
  api: TelegramApi,
  store: BracketStore,
  chatId: string,
  id: string,
): Promise<void> {
  const b = await store.get(id);
  if (!b) {
    await api.sendMessage(chatId, `No bracket ${id}.`);
    return;
  }
  await api.sendMessage(chatId, presentation(b));
}

/** Post the bracket tree to the announce chat (public channel or organizer DM). */
async function announce(api: TelegramApi, b: StoredBracket, header: string): Promise<void> {
  try {
    await api.sendMessage(b.announceChatId, `${header}\n\n${presentation(b)}`);
  } catch (error) {
    console.error(`bracket ${b.state.id} announce failed:`, formatError(error));
  }
}

function presentation(b: StoredBracket): string {
  const s = b.state;
  const chain = s.chain as Chain;
  const lines = [bracketSummary(s)];
  // Link each live match to its tournament page so spectators can watch / play.
  const live = s.matches.filter((m) => m.status === "live" && m.tournamentId);
  if (live.length > 0) {
    lines.push("", "▶ Live matches:");
    for (const m of live) {
      lines.push(`  R${m.round}-${m.indexInRound + 1}: ${tournamentPageUrl(chain, m.tournamentId!)}`);
    }
  }
  return lines.join("\n");
}

// ----- helpers -----

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function findTokenBySymbol(chain: Chain, symbol: string) {
  const want = symbol.toLowerCase();
  return tokensForChain(chain).find((token) => token.symbol.toLowerCase() === want);
}

function toRawAmount(human: string, decimals: number): string {
  const [whole, frac = ""] = human.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0")).toString();
}
