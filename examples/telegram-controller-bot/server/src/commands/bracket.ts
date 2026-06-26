// /bracket — organizer flow to create + run an off-chain 1v1 single-elim
// bracket over Budokan tournaments, with on-chain gating (each round's entry
// requires having won the feeder match). See budokan-sdk `src/brackets`.
//
// Three rosters:
//   - closed: organizer pastes every player up front (addresses or Cartridge
//     usernames) → deploys immediately.
//   - open:   organizer sets a capacity; players /bracket_join until full,
//     then it auto-starts.
//   - mix:    organizer seeds some players + opens the remaining slots.
//
// The whole tree is deployed up front; the bot enters round-1 players on their
// behalf and, as rounds resolve, enters winners into the next gated match.
// Progression is handled by the poller (advanceStoredBracket).

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
  type BracketState,
  type MatchReader,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient } from "@provable-games/denshokan-sdk";
import { num, RpcProvider } from "starknet";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import { TelegramApi } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { keychainSafeRpcUrl } from "../cartridge-link.ts";
import { gamesForChain, type Game } from "../catalog/games.ts";
import { tokensForChain } from "../catalog/tokens.ts";
import { formatError } from "../format-error.ts";
import { BracketStore, type BracketRegistration, type StoredBracket } from "../bracket-store.ts";

type Player = { address: string; name?: string };

// Per-match schedule presets (durations in seconds).
const LENGTH_PRESETS = [
  { label: "Quick — 15m registration, 30m game", reg: 900, game: 1800, sub: 900 },
  { label: "Standard — 1h registration, 6h game", reg: 3600, game: 21600, sub: 3600 },
  { label: "Daily — 6h registration, 24h game", reg: 21600, game: 86400, sub: 21600 },
] as const;

const MODES = [
  { key: "closed", label: "Closed — I'll paste all players now" },
  { key: "open", label: "Open — players join until full, then it starts" },
  { key: "mix", label: "Mix — I seed some, others join the rest" },
] as const;

const CAPACITIES = [4, 8, 16, 32] as const;

interface Draft {
  step: "game" | "mode" | "capacity" | "players" | "length" | "prize" | "confirm";
  chain: Chain;
  games: Game[];
  game?: Game;
  mode?: (typeof MODES)[number]["key"];
  capacity?: number;
  players?: Player[]; // closed: everyone; mix: seeds; open: undefined
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

const isPow2 = (n: number) => n >= 2 && (n & (n - 1)) === 0;

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
    d.step = "mode";
    const lines = [`🎮 ${d.game!.name}. How should players join?`, ""];
    MODES.forEach((m, i) => lines.push(`  ${i + 1}. ${m.label}`));
    lines.push("", "Reply with a number. /cancel to abort.");
    await api.sendMessage(chatId, lines.join("\n"));
    return;
  }

  if (d.step === "mode") {
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > MODES.length) {
      await api.sendMessage(chatId, `Reply 1–${MODES.length}, or /cancel.`);
      return;
    }
    d.mode = MODES[n - 1]!.key;
    if (d.mode === "closed") {
      d.step = "players";
      await api.sendMessage(chatId, pastePrompt("everyone"));
    } else {
      d.step = "capacity";
      const lines = [`Pick the bracket size (capacity):`, ""];
      CAPACITIES.forEach((c, i) => lines.push(`  ${i + 1}. ${c} players`));
      lines.push("", "Reply with a number. /cancel to abort.");
      await api.sendMessage(chatId, lines.join("\n"));
    }
    return;
  }

  if (d.step === "capacity") {
    const n = Number(t);
    if (!/^\d+$/.test(t) || n < 1 || n > CAPACITIES.length) {
      await api.sendMessage(chatId, `Reply 1–${CAPACITIES.length}, or /cancel.`);
      return;
    }
    d.capacity = CAPACITIES[n - 1];
    if (d.mode === "mix") {
      d.step = "players";
      await api.sendMessage(chatId, pastePrompt(`up to ${d.capacity! - 1} seeds (leave the rest open)`));
    } else {
      // open: no seeds
      d.players = [];
      d.step = "length";
      await sendLengthPrompt(api, chatId);
    }
    return;
  }

  if (d.step === "players") {
    const { players, unresolved } = await resolvePlayers(d.chain, t);
    if (unresolved.length > 0) {
      await api.sendMessage(chatId, `Couldn't resolve these Cartridge usernames: ${unresolved.join(", ")}. Fix and resend, or /cancel.`);
      return;
    }
    if (players.length === 0) {
      await api.sendMessage(chatId, "No players parsed. Paste addresses or Cartridge usernames, or /cancel.");
      return;
    }
    if (d.mode === "closed") {
      if (!isPow2(players.length)) {
        await api.sendMessage(chatId, `Got ${players.length}. A closed bracket needs a power of two (2, 4, 8, 16…). Resend, or /cancel.`);
        return;
      }
      d.capacity = players.length;
    } else {
      // mix seeds: must be < capacity and leave a power-of-two final size
      if (players.length >= d.capacity!) {
        await api.sendMessage(chatId, `That's ${players.length} seeds for a ${d.capacity}-player bracket — leave at least one open slot, or use a bigger size. /cancel to abort.`);
        return;
      }
    }
    d.players = players;
    d.step = "length";
    await sendLengthPrompt(api, chatId);
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
      "🏆 Champion prize? Reply `<symbol> <amount>` (e.g. `STRK 100`) to escrow an ERC-20 on the final, or `skip`. /cancel to abort.",
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
      d.prize = { tokenAddress: token.address, amount: toRawAmount(amt, token.decimals), label: `${amt} ${token.symbol}` };
    }
    d.step = "confirm";
    await api.sendMessage(chatId, confirmText(d));
    return;
  }

  if (d.step === "confirm") {
    if (t.toLowerCase() !== "yes") {
      await api.sendMessage(chatId, "Reply 'yes', or /cancel.");
      return;
    }
    drafts.delete(chatId);
    const announceChatId = config.bracketChannelId ?? chatId;

    if (d.mode === "closed") {
      await deployResolved(api, config, store, {
        organizerChatId: chatId,
        announceChatId,
        chain: d.chain,
        game: d.game!,
        length: d.length!,
        prize: d.prize,
        players: d.players!,
      });
      return;
    }

    // open / mix → create a registration that fills before it deploys.
    const reg: BracketRegistration = {
      id: `b${Date.now().toString(36)}`,
      chain: d.chain,
      organizerChatId: chatId,
      announceChatId,
      game: {
        contractAddress: d.game!.contractAddress,
        name: d.game!.name,
        leaderboardAscending: d.game!.leaderboardAscending,
        leaderboardGameMustBeOver: d.game!.leaderboardGameMustBeOver,
      },
      length: { reg: d.length!.reg, game: d.length!.game, sub: d.length!.sub },
      prize: d.prize,
      capacity: d.capacity!,
      players: d.players ?? [],
      createdAt: Date.now(),
    };
    await store.saveRegistration(reg);
    await api.sendMessage(
      chatId,
      `✅ Registration ${reg.id} open (${reg.players.length}/${reg.capacity}). Players join with /bracket_join ${reg.id} (after /connect). It auto-starts when full; you can also force-start with /bracket_start ${reg.id}.`,
    );
    await announceTo(api, reg.announceChatId, registrationText(reg, "🥊 Bracket registration open!"));
    return;
  }
}

// ----- join / start (open & mix) -----

export async function join(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  chain: Chain,
  id: string,
): Promise<void> {
  const reg = await store.getRegistration(id);
  if (!reg) {
    await api.sendMessage(chatId, `No open bracket ${id}.`);
    return;
  }
  const session = await resolveAccount(chatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(chatId, `Run /connect first so I can register your wallet for bracket ${id}.`);
    return;
  }
  const me = session.data.address.toLowerCase();
  if (reg.players.some((p) => p.address.toLowerCase() === me)) {
    await api.sendMessage(chatId, `You're already in bracket ${id} (${reg.players.length}/${reg.capacity}).`);
    return;
  }
  if (reg.players.length >= reg.capacity) {
    await api.sendMessage(chatId, `Bracket ${id} is already full.`);
    return;
  }
  const name = session.data.username && session.data.username !== "unknown" ? session.data.username : undefined;
  reg.players.push({ address: session.data.address, name });
  await store.saveRegistration(reg);
  await api.sendMessage(chatId, `✅ You're in bracket ${id} (${reg.players.length}/${reg.capacity}).`);
  await announceTo(api, reg.announceChatId, registrationText(reg, "📝 New entrant!"));

  if (reg.players.length >= reg.capacity) {
    await deployFromRegistration(api, config, store, reg);
  }
}

export async function startNow(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  chatId: string,
  id: string,
): Promise<void> {
  const reg = await store.getRegistration(id);
  if (!reg) {
    await api.sendMessage(chatId, `No open bracket ${id}.`);
    return;
  }
  if (chatId !== reg.organizerChatId) {
    await api.sendMessage(chatId, `Only the organizer can start bracket ${id}.`);
    return;
  }
  if (!isPow2(reg.players.length)) {
    await api.sendMessage(chatId, `Bracket ${id} has ${reg.players.length} players — need a power of two (2, 4, 8, 16…) to start. Wait for more joins, or /cancel via a new bracket.`);
    return;
  }
  await deployFromRegistration(api, config, store, reg);
}

async function deployFromRegistration(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  reg: BracketRegistration,
): Promise<void> {
  const game: Game = {
    contractAddress: reg.game.contractAddress,
    name: reg.game.name,
    leaderboardAscending: reg.game.leaderboardAscending,
    leaderboardGameMustBeOver: reg.game.leaderboardGameMustBeOver,
  };
  const ok = await deployResolved(api, config, store, {
    organizerChatId: reg.organizerChatId,
    announceChatId: reg.announceChatId,
    chain: reg.chain,
    game,
    length: reg.length,
    prize: reg.prize,
    players: reg.players,
  });
  if (ok) await store.deleteRegistration(reg.id);
}

// ----- deploy (shared) -----

interface DeployParams {
  organizerChatId: string;
  announceChatId: string;
  chain: Chain;
  game: Game;
  length: { reg: number; game: number; sub: number };
  prize?: { tokenAddress: string; amount: string; label: string };
  players: Player[];
}

async function deployResolved(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  p: DeployParams,
): Promise<boolean> {
  const { chain, organizerChatId, announceChatId } = p;
  const session = await resolveAccount(organizerChatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(organizerChatId, `Can't deploy the bracket — the organizer wallet isn't connected on ${chain}. Run /connect and retry.`);
    return false;
  }
  const budokanAddress = config.budokanAddress ?? CHAINS[chain]?.budokanAddress;
  if (!budokanAddress) {
    await api.sendMessage(organizerChatId, `Internal error: no Budokan address for ${chain}.`);
    return false;
  }

  // Fill in any missing display names from Cartridge (best-effort).
  const players = await withUsernames(p.players);

  const id = `b${Date.now().toString(36)}`;
  const state = createBracket({
    id,
    budokanAddress,
    game: p.game.contractAddress,
    chain: chain as BracketState["chain"],
    settingsId: 0,
    creatorRewardsAddress: session.data.address,
    namePrefix: p.game.name.slice(0, 12),
    scheduleTemplate: {
      registrationStartDelay: 0,
      registrationEndDelay: p.length.reg,
      gameStartDelay: p.length.reg,
      gameEndDelay: p.length.game,
      submissionDuration: p.length.sub,
    },
    leaderboard: {
      ascending: p.game.leaderboardAscending ?? false,
      gameMustBeOver: p.game.leaderboardGameMustBeOver ?? false,
    },
    players,
    gated: true,
    finalPrize: p.prize ? { tokenAddress: p.prize.tokenAddress, amount: p.prize.amount } : undefined,
  });

  const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(chain, config.rpcUrl) });
  await api.sendMessage(organizerChatId, `⏳ Deploying ${bracketRounds(state)} rounds of match tournaments…`);
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
      await store.save({ state, organizerChatId, announceChatId });
    }
    for (const m of state.matches.filter((x) => x.round === 1 && x.tournamentId)) {
      for (const player of [m.playerA, m.playerB]) {
        if (!player) continue;
        await session.data.account.execute(bracketEntryCalls(state, m.id, player.address));
      }
    }
    const prizeCalls = bracketFinalPrizeCalls(state);
    if (prizeCalls.length > 0) await session.data.account.execute(prizeCalls);
  } catch (error) {
    await store.save({ state, organizerChatId, announceChatId }).catch(() => {});
    await api.sendMessage(organizerChatId, `❌ Deploy stopped: ${formatError(error)}\nProgress saved — /brackets shows what's live.`);
    return false;
  }

  await store.save({ state, organizerChatId, announceChatId });
  await api.sendMessage(organizerChatId, `✅ Bracket ${id} deployed. Round 1 is live and players are entered.`);
  await announceTo(api, announceChatId, `🥊 The bracket is on!\n\n${presentation({ state, organizerChatId, announceChatId })}`);
  return true;
}

// ----- advancement (poller) -----

export async function advanceStoredBracket(
  api: TelegramApi,
  config: Config,
  store: BracketStore,
  b: StoredBracket,
): Promise<void> {
  const chain = b.state.chain as Chain;
  const session = await resolveAccount(b.organizerChatId, chain, config);
  if (!session.ok) return;

  const before = bracketSummary(b.state);
  const read = buildReader(config, chain);
  const { state } = await advanceBracket(b.state, read);
  b.state = state;

  const entered = new Set<string>(b.entered ?? []);
  for (const m of state.matches) {
    if (m.round === 1 || !m.tournamentId || entered.has(m.id)) continue;
    if (!m.playerA || !m.playerB) continue;
    try {
      for (const player of [m.playerA, m.playerB]) {
        await session.data.account.execute(bracketEntryCalls(state, m.id, player.address));
      }
      entered.add(m.id);
    } catch (error) {
      console.error(`bracket ${state.id} enter ${m.id} failed:`, formatError(error));
    }
  }
  b.entered = [...entered];
  await store.save(b);

  if (bracketSummary(b.state) !== before) {
    const header = b.state.status === "complete" ? "🏆 Bracket complete!" : "📣 Bracket update";
    await announceTo(api, b.announceChatId, `${header}\n\n${presentation(b)}`);
  }
}

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
    if (!(gameEnd > 0 && now >= gameEnd)) return { finished: false, ranking: [] };

    const lb = await client.getTournamentLeaderboard(tournamentId);
    const ranking: Array<{ address: string; position: number; tokenId?: string }> = [];
    for (const e of lb) {
      let owner = "";
      try {
        owner = (await denshokan.getToken(e.tokenId)).owner ?? "";
      } catch {
        // unknown owner — skip
      }
      if (owner) ranking.push({ address: owner, position: e.position, tokenId: e.tokenId });
    }
    return { finished: true, ranking };
  };
}

// ----- listing + presentation -----

export async function list(
  api: TelegramApi,
  store: BracketStore,
  chatId: string,
  chain: Chain,
): Promise<void> {
  const deployed = (await store.all()).filter((b) => (b.state.chain as Chain) === chain);
  const open = (await store.allRegistrations()).filter((r) => r.chain === chain);
  if (deployed.length === 0 && open.length === 0) {
    await api.sendMessage(chatId, `No brackets on ${chain}. Create one with /bracket.`);
    return;
  }
  const lines = [`🥊 Brackets on ${chain}:`, ""];
  for (const r of open) {
    lines.push(`  • ${r.id} [registering ${r.players.length}/${r.capacity}] · join: /bracket_join ${r.id}`);
  }
  for (const b of deployed) {
    const champ = b.state.champion ? ` — 🏆 ${b.state.champion.name ?? short(b.state.champion.address)}` : "";
    lines.push(`  • ${b.state.id} [${b.state.status}] · ${b.state.players.length} players${champ} · /bracket_view ${b.state.id}`);
  }
  await api.sendMessage(chatId, lines.join("\n"));
}

export async function view(
  api: TelegramApi,
  store: BracketStore,
  chatId: string,
  id: string,
): Promise<void> {
  const b = await store.get(id);
  if (b) {
    await api.sendMessage(chatId, presentation(b));
    return;
  }
  const reg = await store.getRegistration(id);
  if (reg) {
    await api.sendMessage(chatId, registrationText(reg, `Bracket ${id} — registering`));
    return;
  }
  await api.sendMessage(chatId, `No bracket ${id}.`);
}

async function announceTo(api: TelegramApi, chatId: string, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, text);
  } catch (error) {
    console.error("bracket announce failed:", formatError(error));
  }
}

function registrationText(reg: BracketRegistration, header: string): string {
  const lines = [
    header,
    `Game: ${reg.game.name} · ${reg.players.length}/${reg.capacity} joined${reg.prize ? ` · 🏆 ${reg.prize.label}` : ""}`,
    "",
  ];
  reg.players.forEach((p, i) => lines.push(`  ${i + 1}. ${p.name ?? short(p.address)}`));
  if (reg.players.length < reg.capacity) {
    lines.push("", `Join with /bracket_join ${reg.id} (after /connect).`);
  }
  return lines.join("\n");
}

function presentation(b: StoredBracket): string {
  const s = b.state;
  const chain = s.chain as Chain;
  const lines = [bracketSummary(s)];
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

function pastePrompt(who: string): string {
  return [
    `Paste ${who} — one per line, each a 0x address or a Cartridge username:`,
    "```",
    "shinobi",
    "0x456… bob",
    "```",
    "Power-of-two final size (2, 4, 8, 16…). /cancel to abort.",
  ].join("\n");
}

async function sendLengthPrompt(api: TelegramApi, chatId: string): Promise<void> {
  const lines = ["Pick a match length:", ""];
  LENGTH_PRESETS.forEach((p, i) => lines.push(`  ${i + 1}. ${p.label}`));
  lines.push("", "Reply with a number. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

function confirmText(d: Draft): string {
  const roster =
    d.mode === "open"
      ? `open, capacity ${d.capacity}`
      : d.mode === "mix"
        ? `mix — ${d.players!.length} seeded, capacity ${d.capacity}`
        : `closed — ${d.players!.length} players`;
  return [
    "🧾 Confirm bracket:",
    `  • Game: ${d.game!.name}`,
    `  • Roster: ${roster}`,
    `  • Match length: ${d.length!.label}`,
    `  • Champion prize: ${d.prize ? d.prize.label : "none"}`,
    "",
    d.mode === "closed"
      ? "Deploys the gated tree now and enters round 1 for the players."
      : "Opens registration; deploys automatically when it fills.",
    "",
    "Reply 'yes', or /cancel.",
  ].join("\n");
}

/** Parse pasted lines into players, resolving Cartridge usernames → addresses. */
async function resolvePlayers(
  _chain: Chain,
  text: string,
): Promise<{ players: Player[]; unresolved: string[] }> {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const usernames: string[] = [];
  const parsed: Array<{ address?: string; username?: string; name?: string }> = [];
  for (const line of lines) {
    const [first, ...rest] = line.split(/\s+/);
    if (!first) continue;
    if (/^0x[0-9a-fA-F]+$/.test(first)) {
      parsed.push({ address: first, name: rest.join(" ") || undefined });
    } else {
      usernames.push(first);
      parsed.push({ username: first });
    }
  }
  const map =
    usernames.length > 0
      ? await lookupUsernamesToAddresses(usernames).catch(() => new Map<string, string>())
      : new Map<string, string>();
  const players: Player[] = [];
  const unresolved: string[] = [];
  for (const p of parsed) {
    if (p.address) {
      players.push({ address: p.address, name: p.name });
    } else {
      const addr = map.get(p.username!.toLowerCase());
      if (!addr) unresolved.push(p.username!);
      else players.push({ address: addr, name: p.username });
    }
  }
  return { players, unresolved };
}

/** Fill missing display names via a reverse Cartridge lookup (best-effort). */
async function withUsernames(players: Player[]): Promise<Player[]> {
  const missing = players.filter((p) => !p.name).map((p) => p.address);
  if (missing.length === 0) return players;
  const map = await lookupAddressesToUsernames(missing).catch(() => new Map<string, string>());
  return players.map((p) => (p.name ? p : { ...p, name: map.get(num.toHex(p.address)) }));
}

// Cartridge username ↔ controller-address lookup (https://api.cartridge.gg/lookup).
// POST { usernames? , addresses? } → { results: [{ username, addresses[] }] }.
interface CartridgeLookupResult {
  username: string;
  addresses: string[];
}

async function cartridgeLookup(body: {
  usernames?: string[];
  addresses?: string[];
}): Promise<CartridgeLookupResult[]> {
  if (!body.usernames?.length && !body.addresses?.length) return [];
  const res = await fetch("https://api.cartridge.gg/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Cartridge lookup failed: ${res.status}`);
  const data = (await res.json()) as { results?: CartridgeLookupResult[] };
  return data.results ?? [];
}

/** username (lowercased) → controller address. */
async function lookupUsernamesToAddresses(usernames: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await cartridgeLookup({ usernames })) {
    if (r.addresses?.[0]) out.set(r.username.toLowerCase(), r.addresses[0]);
  }
  return out;
}

/** num.toHex(address) → username. */
async function lookupAddressesToUsernames(addresses: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await cartridgeLookup({ addresses })) {
    if (r.addresses?.[0]) out.set(num.toHex(r.addresses[0]), r.username);
  }
  return out;
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

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
