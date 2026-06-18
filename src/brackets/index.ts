/**
 * 1v1 single-elimination brackets, orchestrated off-chain over ordinary
 * Budokan leaderboard tournaments. See ./DESIGN.md for the full rationale.
 *
 *   One match = one 2-player leaderboard tournament.
 *
 * The contract has no notion of brackets/rounds/elimination — this module
 * adds them by (a) seeding players into a tree, (b) emitting the calldata
 * to create each round's match tournaments, and (c) resolving winners from
 * each finished match's leaderboard and advancing them. State is plain
 * JSON (the caller persists it); the module never signs or executes — it
 * returns `Call`s for the caller to run, mirroring `src/calldata`.
 */
import {
  buildCreateTournamentCall,
  buildEnterTournamentCall,
  type Call,
  type CreateTournamentArgs,
} from "../calldata/index.js";
import type { WhitelistChain } from "../games/whitelist.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MatchStatus =
  | "pending" // both players known, tournament not yet created
  | "awaiting_players" // a feeding match hasn't resolved yet
  | "live" // match tournament created; players competing
  | "resolved" // winner decided from the leaderboard
  | "bye" // single competitor (auto-advances, no tournament)
  | "walkover"; // opponent no-showed; winner advanced without a full match

export interface BracketPlayer {
  /** Player wallet address. */
  address: string;
  /** Optional display name (≤31 ASCII bytes for on-chain player_name). */
  name?: string;
  /** 1-based seed; 1 = strongest. */
  seed: number;
}

export interface BracketMatch {
  id: string;
  /** 1-based round number (1 = first round). */
  round: number;
  /** 0-based index within the round. */
  indexInRound: number;
  playerA?: BracketPlayer;
  playerB?: BracketPlayer;
  /** The on-chain match tournament id, once created. */
  tournamentId?: string;
  status: MatchStatus;
  winner?: BracketPlayer;
  /** Next-round match id this match's winner feeds into (undefined = final). */
  feedsInto?: string;
}

/** Per-match tournament schedule (durations in seconds). */
export interface MatchScheduleTemplate {
  registrationStartDelay: number;
  registrationEndDelay: number;
  gameStartDelay: number;
  gameEndDelay: number;
  submissionDuration: number;
}

export interface BracketState {
  id: string;
  /** Budokan contract address every match tournament is created on. */
  budokanAddress: string;
  /** Game contract address every match uses. */
  game: string;
  chain: WhitelistChain;
  settingsId: number;
  /** Address that receives tournament-creator rewards on each match. */
  creatorRewardsAddress: string;
  scheduleTemplate: MatchScheduleTemplate;
  leaderboard: { ascending: boolean; gameMustBeOver: boolean };
  /** Short label prefixed onto each match tournament name (≤ ~20 bytes). */
  namePrefix: string;
  /** Bracket size = next power of two ≥ players.length. */
  size: number;
  players: BracketPlayer[];
  matches: BracketMatch[];
  status: "running" | "complete";
  champion?: BracketPlayer;
}

export interface CreateBracketOptions {
  id: string;
  /** Budokan contract address every match tournament is created on. */
  budokanAddress: string;
  game: string;
  chain: WhitelistChain;
  settingsId: number;
  creatorRewardsAddress: string;
  scheduleTemplate: MatchScheduleTemplate;
  leaderboard: { ascending: boolean; gameMustBeOver: boolean };
  namePrefix?: string;
  /** Competitors. Order = seed order unless `seeding: "random"`. */
  players: Array<{ address: string; name?: string }>;
  /** "as-given" (default) keeps the input order; "random" shuffles. */
  seeding?: "as-given" | "random";
  /** Deterministic shuffle seed (only used when seeding === "random"). */
  shuffleSeed?: number;
}

/** A match tournament that needs creating, paired with its match id. */
export interface CreateMatchCall {
  matchId: string;
  call: Call;
}

/**
 * Final ranking of a match tournament, as seen by the caller's reader.
 * `finished` is true once the tournament's submission window has closed
 * (or it's otherwise final). `ranking` is the leaderboard mapped to player
 * addresses, position 1 first. The reader owns RPC + tokenId→address
 * mapping so this module stays pure.
 */
export interface MatchResult {
  finished: boolean;
  ranking: Array<{ address: string; position: number }>;
}

export type MatchReader = (tournamentId: string) => Promise<MatchResult>;

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(n));
}

/**
 * Standard single-elimination seed slot order for a bracket of `size`
 * (a power of two). Returns seed numbers in slot order so that top seeds
 * are spread apart (1 and 2 can only meet in the final). E.g. size 4 →
 * [1,4,2,3]; size 8 → [1,8,4,5,2,7,3,6].
 */
function seedSlotOrder(size: number): number[] {
  let slots = [1, 2];
  while (slots.length < size) {
    const sum = slots.length * 2 + 1;
    const next: number[] = [];
    for (const s of slots) {
      next.push(s, sum - s);
    }
    slots = next;
  }
  return slots;
}

/** Deterministic mulberry32-style shuffle so brackets are reproducible. */
function shuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let state = (seed >>> 0) || 1;
  const rand = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

const matchId = (bracketId: string, round: number, index: number) =>
  `${bracketId}-r${round}-m${index}`;

/**
 * Build a seeded single-elimination bracket. Players beyond the next
 * power-of-two get spread-out byes on the top seeds. Round-1 bye matches
 * resolve immediately and their winners are propagated into round 2.
 */
export function createBracket(opts: CreateBracketOptions): BracketState {
  if (opts.players.length < 2) {
    throw new Error("A bracket needs at least 2 players");
  }
  const ordered =
    opts.seeding === "random"
      ? shuffle(opts.players, opts.shuffleSeed ?? 1)
      : opts.players;
  const players: BracketPlayer[] = ordered.map((p, i) => ({
    address: p.address,
    name: p.name,
    seed: i + 1,
  }));
  const count = players.length;
  const size = nextPowerOfTwo(count);
  const rounds = Math.log2(size);
  const bySeed = new Map(players.map((p) => [p.seed, p]));

  const matches: BracketMatch[] = [];

  // Round 1 from the seed slot order. A slot whose seed > count is a bye.
  const slots = seedSlotOrder(size);
  const round1Count = size / 2;
  for (let i = 0; i < round1Count; i++) {
    const seedA = slots[i * 2]!;
    const seedB = slots[i * 2 + 1]!;
    const playerA = bySeed.get(seedA);
    const playerB = bySeed.get(seedB);
    matches.push({
      id: matchId(opts.id, 1, i),
      round: 1,
      indexInRound: i,
      playerA,
      playerB,
      status: "pending",
      feedsInto: rounds > 1 ? matchId(opts.id, 2, Math.floor(i / 2)) : undefined,
    });
  }

  // Rounds 2..rounds: empty shells, players arrive as feeders resolve.
  for (let r = 2; r <= rounds; r++) {
    const n = size / 2 ** r;
    for (let i = 0; i < n; i++) {
      matches.push({
        id: matchId(opts.id, r, i),
        round: r,
        indexInRound: i,
        status: "awaiting_players",
        feedsInto:
          r < rounds ? matchId(opts.id, r + 1, Math.floor(i / 2)) : undefined,
      });
    }
  }

  const state: BracketState = {
    id: opts.id,
    budokanAddress: opts.budokanAddress,
    game: opts.game,
    chain: opts.chain,
    settingsId: opts.settingsId,
    creatorRewardsAddress: opts.creatorRewardsAddress,
    scheduleTemplate: opts.scheduleTemplate,
    leaderboard: opts.leaderboard,
    namePrefix: opts.namePrefix ?? "Match",
    size,
    players,
    matches,
    status: "running",
  };

  // Resolve byes and any matches that now have both players known.
  resolveByes(state);
  refreshMatchStatuses(state);
  return state;
}

// ---------------------------------------------------------------------------
// Internal state transitions
// ---------------------------------------------------------------------------

function findMatch(state: BracketState, id: string): BracketMatch | undefined {
  return state.matches.find((m) => m.id === id);
}

/** Place a winner into the slot of the match it feeds into. */
function propagate(state: BracketState, match: BracketMatch): void {
  if (!match.feedsInto || !match.winner) return;
  const parent = findMatch(state, match.feedsInto);
  if (!parent) return;
  // Even source index → slot A, odd → slot B (preserves bracket adjacency).
  if (match.indexInRound % 2 === 0) parent.playerA = match.winner;
  else parent.playerB = match.winner;
}

/**
 * A round-1 match with exactly one competitor is a bye: the present player
 * advances with no tournament. Runs at creation time only (rounds ≥ 2 are
 * fed by real winners, never byes).
 */
function resolveByes(state: BracketState): void {
  for (const m of state.matches) {
    if (m.round !== 1) continue;
    const a = m.playerA;
    const b = m.playerB;
    if (a && !b) {
      m.winner = a;
      m.status = "bye";
      propagate(state, m);
    } else if (b && !a) {
      m.winner = b;
      m.status = "bye";
      propagate(state, m);
    }
  }
}

/**
 * A match is "pending" (ready to create) once both players are known and
 * no tournament exists yet; otherwise it waits. Leaves live/resolved/bye
 * matches untouched.
 */
function refreshMatchStatuses(state: BracketState): void {
  for (const m of state.matches) {
    if (m.status === "live" || m.status === "resolved" || m.status === "bye" || m.status === "walkover") {
      continue;
    }
    const ready = !!m.playerA && !!m.playerB;
    m.status = ready ? "pending" : "awaiting_players";
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Build the `create_tournament` Call for a single match. */
function matchCreateCall(state: BracketState, match: BracketMatch): Call {
  const args: CreateTournamentArgs = {
    creatorRewardsAddress: state.creatorRewardsAddress,
    name: `${state.namePrefix} R${match.round}-${match.indexInRound + 1}`.slice(0, 31),
    description: `Bracket ${state.id} - round ${match.round}, match ${match.indexInRound + 1}`,
    gameAddress: state.game,
    settingsId: state.settingsId,
    schedule: { ...state.scheduleTemplate },
    leaderboard: { ...state.leaderboard },
  };
  return buildCreateTournamentCall(state.budokanAddress, args);
}

/**
 * Calls to create every match that's ready (both players known, no
 * tournament yet). Run these, then feed each resulting tournament id back
 * via `attachMatchTournament`.
 */
export function pendingMatchCreateCalls(state: BracketState): CreateMatchCall[] {
  return state.matches
    .filter((m) => m.status === "pending" && !m.tournamentId)
    .map((m) => ({ matchId: m.id, call: matchCreateCall(state, m) }));
}

/** Record the on-chain tournament id for a created match → marks it live. */
export function attachMatchTournament(
  state: BracketState,
  matchIdToAttach: string,
  tournamentId: string,
): BracketState {
  const m = findMatch(state, matchIdToAttach);
  if (!m) throw new Error(`Unknown match: ${matchIdToAttach}`);
  m.tournamentId = tournamentId;
  m.status = "live";
  return state;
}

/** Build the enter call(s) for a player joining their (live) match. */
export function bracketEntryCalls(
  state: BracketState,
  matchIdToEnter: string,
  playerAddress: string,
): Call[] {
  const m = findMatch(state, matchIdToEnter);
  if (!m) throw new Error(`Unknown match: ${matchIdToEnter}`);
  if (!m.tournamentId) {
    throw new Error(`Match ${matchIdToEnter} has no tournament yet`);
  }
  const player =
    m.playerA?.address === playerAddress
      ? m.playerA
      : m.playerB?.address === playerAddress
        ? m.playerB
        : undefined;
  if (!player) {
    throw new Error(`${playerAddress} is not a competitor in ${matchIdToEnter}`);
  }
  return [
    buildEnterTournamentCall(state.budokanAddress, {
      tournamentId: m.tournamentId,
      playerAddress: player.address,
      playerName: player.name,
    }),
  ];
}

/** The match(es) a given address should play next (live or pending). */
export function nextMatchesFor(
  state: BracketState,
  address: string,
): BracketMatch[] {
  return state.matches.filter(
    (m) =>
      (m.status === "live" || m.status === "pending") &&
      (m.playerA?.address === address || m.playerB?.address === address),
  );
}

/** Pick the winner of a finished match from its ranking + competitors. */
function resolveWinner(
  match: BracketMatch,
  result: MatchResult,
): { winner: BracketPlayer; status: "resolved" | "walkover" } {
  const a = match.playerA!;
  const b = match.playerB!;
  const byAddr = new Map(result.ranking.map((r) => [r.address, r.position]));
  const posA = byAddr.get(a.address);
  const posB = byAddr.get(b.address);

  if (posA !== undefined && posB !== undefined) {
    return { winner: posA <= posB ? a : b, status: "resolved" };
  }
  if (posA !== undefined) return { winner: a, status: "walkover" };
  if (posB !== undefined) return { winner: b, status: "walkover" };
  // Neither submitted a score: higher seed (lower number) advances.
  return { winner: a.seed <= b.seed ? a : b, status: "walkover" };
}

/**
 * Advance the bracket: read every live match, resolve the finished ones,
 * propagate winners, and return the calls needed to create the next batch
 * of now-ready matches. Pure w.r.t. chain I/O — all reads go through
 * `read`; all writes are returned as `createCalls` for the caller to sign.
 *
 * Typical loop: `const { state, createCalls } = await advanceBracket(...)`,
 * execute each call, `attachMatchTournament(state, matchId, id)`, repeat.
 */
export async function advanceBracket(
  state: BracketState,
  read: MatchReader,
): Promise<{ state: BracketState; createCalls: CreateMatchCall[] }> {
  // 1. Resolve finished live matches.
  for (const m of state.matches) {
    if (m.status !== "live" || !m.tournamentId) continue;
    const result = await read(m.tournamentId);
    if (!result.finished) continue;
    const { winner, status } = resolveWinner(m, result);
    m.winner = winner;
    m.status = status;
    propagate(state, m);
  }

  // 2. Newly-fed matches may now be ready (or themselves resolved-by-final).
  refreshMatchStatuses(state);

  // 3. Champion check: the final (a match with no feedsInto) is decided.
  const final = state.matches.find((m) => !m.feedsInto);
  if (final && (final.status === "resolved" || final.status === "walkover")) {
    state.status = "complete";
    state.champion = final.winner;
  }

  return { state, createCalls: pendingMatchCreateCalls(state) };
}

/** Compact ASCII summary of the bracket, grouped by round. */
export function bracketSummary(state: BracketState): string {
  const rounds = Math.max(...state.matches.map((m) => m.round));
  const lines: string[] = [`Bracket ${state.id} — ${state.status}`];
  for (let r = 1; r <= rounds; r++) {
    const label = r === rounds ? "Final" : `Round ${r}`;
    lines.push(`\n${label}:`);
    for (const m of state.matches.filter((x) => x.round === r)) {
      const a = m.playerA ? (m.playerA.name ?? short(m.playerA.address)) : "—";
      const b = m.playerB ? (m.playerB.name ?? short(m.playerB.address)) : "—";
      const w = m.winner ? ` → ${m.winner.name ?? short(m.winner.address)}` : "";
      lines.push(`  ${a} vs ${b} [${m.status}]${w}`);
    }
  }
  if (state.champion) {
    lines.push(`\n🏆 ${state.champion.name ?? short(state.champion.address)}`);
  }
  return lines.join("\n");
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
