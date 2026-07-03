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
  buildAddPrizeCall,
  buildCreateTournamentCall,
  buildEnterTournamentCall,
  buildErc20ApproveCall,
  type Call,
  type CreateTournamentArgs,
  type EntryRequirementArgs,
} from "../calldata/index.js";
import {
  buildMerkleConfig,
  buildTournamentQualificationProof,
  buildTournamentValidatorConfig,
  extensionAddressFor,
} from "../extensions/index.js";
import type { WhitelistChain } from "../games/whitelist.js";
import { normalizeAddress } from "../utils/address.js";

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

/** A signed-up player during the `registering` phase (pre-assignment). */
export interface Registrant {
  address: string;
  name?: string;
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
  /**
   * Winning game-token id from this match's leaderboard. Captured on resolve;
   * needed as the `QualificationProof` token when the winner enters the gated
   * next-round match.
   */
  winnerTokenId?: string;
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
  /**
   * Optional per-round game settings (0-indexed by round-1): round `r` uses
   * `roundSettingsIds[r-1]` when present, else falls back to `settingsId`. Lets
   * a bracket escalate difficulty as rounds progress.
   */
  roundSettingsIds?: number[];
  /**
   * Optional organizer blurb used as every match tournament's on-chain
   * description (grouping reads the gating, not the text, so this is free-form).
   * Falls back to a generated "Bracket <id> - round/match" line when unset.
   */
  description?: string;
  /**
   * When true (the upfront model), round >1 matches are created with an
   * entry_requirement gating entry to the winners of their two feeder matches
   * (tournament validator, "won at least one of [feederA, feederB]"). Round
   * schedules are staggered so each round opens after the previous finishes.
   */
  gated: boolean;
  /**
   * Optional per-match round-1 merkle allowlist, keyed by match id → on-chain
   * `treeId`. When a round-1 match has a `treeId`, it's created with a merkle
   * `entry_requirement` (allowlist gating, `entryLimit` 1) so only the
   * allowlisted addresses can enter that match — closing the round-1 client
   * bypass. Populate after registering the trees (see `attachRoundOneTree`).
   */
  roundOneTreeIds?: Record<string, number>;
  /** Optional ERC20 prize escrowed on the final match for the champion. */
  finalPrize?: { tokenAddress: string; amount: string };
  /** Bracket size = next power of two ≥ players.length (or the registration capacity). */
  size: number;
  players: BracketPlayer[];
  matches: BracketMatch[];
  /**
   * Signups captured during the `registering` phase, before they're shuffled
   * and assigned to round-1 slots by `assignRegistrants`. Empty/undefined once
   * running.
   */
  registrants?: Registrant[];
  status: "registering" | "running" | "complete";
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
  /** Optional per-round settings (0-indexed by round-1); falls back to settingsId. */
  roundSettingsIds?: number[];
  /** Optional organizer blurb used as each match's on-chain description. */
  description?: string;
  /** Competitors. Order = seed order unless `seeding: "random"`. */
  players: Array<{ address: string; name?: string }>;
  /** "as-given" (default) keeps the input order; "random" shuffles. */
  seeding?: "as-given" | "random";
  /** Deterministic shuffle seed (only used when seeding === "random"). */
  shuffleSeed?: number;
  /**
   * Gate round >1 entry on having won a feeder match (default true — the
   * upfront on-chain-enforced model). Set false for a coordinator-trusted
   * bracket with no entry_requirement.
   */
  gated?: boolean;
  /**
   * Optional per-match round-1 merkle allowlist (match id → on-chain `treeId`).
   * Usually attached after creation via `attachRoundOneTree` once the trees are
   * registered, but may be provided up front if the ids are already known.
   */
  roundOneTreeIds?: Record<string, number>;
  /** Optional ERC20 prize escrowed on the final match for the champion. */
  finalPrize?: { tokenAddress: string; amount: string };
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
  ranking: Array<{ address: string; position: number; tokenId?: string }>;
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
  // Byes can't be expressed as an on-chain entry gate (there's no feeder
  // tournament to have "won"), so gated brackets require a power-of-two roster.
  const gated = opts.gated ?? true;
  if (gated && opts.players.length !== nextPowerOfTwo(opts.players.length)) {
    throw new Error(
      `A gated bracket needs a power-of-two player count (got ${opts.players.length}; use 2, 4, 8, 16, …). Disable gating to allow byes.`,
    );
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
    ...(opts.roundSettingsIds ? { roundSettingsIds: opts.roundSettingsIds } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    gated,
    ...(opts.roundOneTreeIds ? { roundOneTreeIds: opts.roundOneTreeIds } : {}),
    finalPrize: opts.finalPrize,
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
// Registration phase (open brackets: sign up → shuffle → assign → deploy)
//
// A registering bracket has capacity (`size`) but no players/matches yet.
// Players sign up (`addRegistrant`) until it fills; `assignRegistrants` then
// shuffles the signups (deterministically) into round-1 slots and returns a
// normal running bracket. Signing/UI/persistence live in the consumer; these
// transitions are pure so any client (web / Telegram / Discord) reuses them.
// ---------------------------------------------------------------------------

/** Options for an open bracket that starts in the `registering` phase. */
export interface CreateRegisteringBracketOptions
  extends Omit<CreateBracketOptions, "players" | "seeding" | "shuffleSeed"> {
  /** Bracket capacity in slots — a power of two ≥ 2 (2, 4, 8, 16, …). */
  size: number;
}

/**
 * Create an open bracket in the `registering` phase: capacity is fixed but no
 * players are assigned yet. Collect signups with `addRegistrant`, then call
 * `assignRegistrants` once full (or at a deadline) to build the round-1 tree.
 */
export function createRegisteringBracket(
  opts: CreateRegisteringBracketOptions,
): BracketState {
  if (opts.size < 2 || opts.size !== nextPowerOfTwo(opts.size)) {
    throw new Error(
      `Registration capacity must be a power of two ≥ 2 (got ${opts.size}; use 2, 4, 8, 16, …).`,
    );
  }
  return {
    id: opts.id,
    budokanAddress: opts.budokanAddress,
    game: opts.game,
    chain: opts.chain,
    settingsId: opts.settingsId,
    creatorRewardsAddress: opts.creatorRewardsAddress,
    scheduleTemplate: opts.scheduleTemplate,
    leaderboard: opts.leaderboard,
    namePrefix: opts.namePrefix ?? "Match",
    ...(opts.roundSettingsIds ? { roundSettingsIds: opts.roundSettingsIds } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    gated: opts.gated ?? true,
    ...(opts.roundOneTreeIds ? { roundOneTreeIds: opts.roundOneTreeIds } : {}),
    finalPrize: opts.finalPrize,
    size: opts.size,
    players: [],
    matches: [],
    registrants: [],
    status: "registering",
  };
}

/**
 * Add a signup to a registering bracket. Dedupes by address (case-insensitive)
 * and enforces capacity (`size`). Mutates and returns `state`.
 */
export function addRegistrant(state: BracketState, registrant: Registrant): BracketState {
  if (state.status !== "registering") {
    throw new Error(`Bracket ${state.id} is not registering (status: ${state.status})`);
  }
  const list = (state.registrants ??= []);
  // Dedup on the canonical (padded-lowercase) form so `0x1` and `0x01` count as
  // one wallet — `.toLowerCase()` alone misses leading-zero variants. But STORE
  // the original address: `createBracket` and winner resolution compare raw
  // addresses, so keeping registrants raw (like every other bracket) avoids a
  // raw-vs-normalized mismatch there. Normalization stays where it's actually
  // required — the dedup key here, the merkle tree/proof, and entry lookups.
  const key = normalizeAddress(registrant.address);
  if (list.some((r) => normalizeAddress(r.address) === key)) {
    return state; // already signed up — idempotent
  }
  if (list.length >= state.size) {
    throw new Error(`Bracket ${state.id} is full (${state.size} slots)`);
  }
  list.push({ address: registrant.address, ...(registrant.name ? { name: registrant.name } : {}) });
  return state;
}

/** Remove a signup by address (representation-insensitive). Mutates and returns `state`. */
export function removeRegistrant(state: BracketState, address: string): BracketState {
  if (state.status !== "registering") {
    throw new Error(`Bracket ${state.id} is not registering (status: ${state.status})`);
  }
  const key = normalizeAddress(address);
  state.registrants = (state.registrants ?? []).filter(
    (r) => normalizeAddress(r.address) !== key,
  );
  return state;
}

/** Options controlling how registrants are assigned to round-1 slots. */
export interface AssignRegistrantsOptions {
  /** "random" (default) shuffles signups; "as-given" keeps signup order. */
  seeding?: "as-given" | "random";
  /** Deterministic shuffle seed (used when seeding === "random"). */
  shuffleSeed?: number;
}

/**
 * Close registration and build the running bracket: shuffle the signups
 * (deterministically, via the caller-supplied `shuffleSeed`) into seed order
 * and construct the round-1 tree. Returns a fresh `running` bracket built with
 * the registering bracket's config — round-1 merkle trees are attached
 * afterwards with `attachRoundOneTree` (their addresses are only known now).
 */
export function assignRegistrants(
  state: BracketState,
  opts: AssignRegistrantsOptions = {},
): BracketState {
  if (state.status !== "registering") {
    throw new Error(`Bracket ${state.id} is not registering (status: ${state.status})`);
  }
  const registrants = state.registrants ?? [];
  if (registrants.length < 2) {
    throw new Error(`Bracket ${state.id} needs at least 2 registrants to assign (got ${registrants.length})`);
  }
  const seeding = opts.seeding ?? "random";
  // A gated bracket can't express byes, so the field must be a power of two.
  // Validate here for a clear message instead of leaking createBracket's error.
  if (state.gated && registrants.length !== nextPowerOfTwo(registrants.length)) {
    throw new Error(
      `Bracket ${state.id}: a gated bracket needs a power-of-two registrant count to assign ` +
        `(got ${registrants.length}/${state.size} filled). Fill to a power of two (ideally the ` +
        `capacity ${state.size}), or create it with gated: false to allow byes.`,
    );
  }
  // Pre-attached round-1 trees are keyed by positional match id, so a random
  // shuffle would re-bind them to the wrong players. Only carry them through a
  // deterministic assignment; otherwise attach trees AFTER assignment (their
  // players are only known then) via attachRoundOneTree.
  if (state.roundOneTreeIds && Object.keys(state.roundOneTreeIds).length > 0 && seeding !== "as-given") {
    throw new Error(
      `Bracket ${state.id}: pre-attached roundOneTreeIds can't survive a random shuffle ` +
        `(they're keyed by match slot). Use seeding: "as-given", or attach trees after ` +
        `assignment with attachRoundOneTree.`,
    );
  }
  // Reuse createBracket so seeding, byes, tree construction, and gating rules
  // stay in one place — including the deterministic shuffle.
  return createBracket({
    id: state.id,
    budokanAddress: state.budokanAddress,
    game: state.game,
    chain: state.chain,
    settingsId: state.settingsId,
    creatorRewardsAddress: state.creatorRewardsAddress,
    scheduleTemplate: state.scheduleTemplate,
    leaderboard: state.leaderboard,
    namePrefix: state.namePrefix,
    ...(state.roundSettingsIds ? { roundSettingsIds: state.roundSettingsIds } : {}),
    ...(state.description ? { description: state.description } : {}),
    players: registrants.map((r) => ({ address: r.address, ...(r.name ? { name: r.name } : {}) })),
    seeding,
    ...(opts.shuffleSeed !== undefined ? { shuffleSeed: opts.shuffleSeed } : {}),
    gated: state.gated,
    // Preserve any pre-attached round-1 tree ids across the transition —
    // otherwise those matches would silently deploy ungated.
    ...(state.roundOneTreeIds ? { roundOneTreeIds: state.roundOneTreeIds } : {}),
    ...(state.finalPrize ? { finalPrize: state.finalPrize } : {}),
  });
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
/**
 * The round-1 merkle allowlist entry requirement for a match, or undefined when
 * it has no allowlist tree. Applied by BOTH create paths (`matchCreateCall` and
 * `gatedMatchCreateCall`) so round-1 gating is never silently dropped depending
 * on which one the caller happens to use.
 */
function roundOneMerkleRequirement(
  state: BracketState,
  match: BracketMatch,
): EntryRequirementArgs | undefined {
  const treeId = match.round === 1 ? state.roundOneTreeIds?.[match.id] : undefined;
  if (treeId === undefined) return undefined;
  return {
    entryLimit: 1,
    type: {
      kind: "extension",
      address: extensionAddressFor(state.chain, "merkle"),
      config: buildMerkleConfig({ treeId }),
    },
  };
}

function matchCreateCall(state: BracketState, match: BracketMatch): Call {
  const entryRequirement = roundOneMerkleRequirement(state, match);
  const args: CreateTournamentArgs = {
    creatorRewardsAddress: state.creatorRewardsAddress,
    name: `${state.namePrefix} R${match.round}-${match.indexInRound + 1}`.slice(0, 31),
    description: state.description ?? `Bracket ${state.id} - round ${match.round}, match ${match.indexInRound + 1}`,
    gameAddress: state.game,
    settingsId: state.roundSettingsIds?.[match.round - 1] ?? state.settingsId,
    schedule: { ...state.scheduleTemplate },
    leaderboard: { ...state.leaderboard },
    ...(entryRequirement ? { entryRequirement } : {}),
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

/**
 * Record the merkle allowlist tree id for a round-1 match, so it's created
 * with an allowlist `entry_requirement`. Call after registering the tree
 * on-chain (see `buildRegisterAllowlistTreeCall` / `parseAllowlistTreeId`) and
 * before `roundMatchCreateCalls(state, 1)`. Mutates and returns `state`.
 */
export function attachRoundOneTree(
  state: BracketState,
  matchIdToAttach: string,
  treeId: number,
): BracketState {
  const m = findMatch(state, matchIdToAttach);
  if (!m) throw new Error(`Unknown match: ${matchIdToAttach}`);
  if (m.round !== 1) {
    throw new Error(`Merkle allowlist gating is round-1 only; ${matchIdToAttach} is round ${m.round}`);
  }
  if (m.tournamentId) {
    throw new Error(`Match ${matchIdToAttach} is already created — attach the tree before creating it`);
  }
  state.roundOneTreeIds = { ...(state.roundOneTreeIds ?? {}), [matchIdToAttach]: treeId };
  return state;
}

// ---------------------------------------------------------------------------
// Upfront gated deploy
//
// The whole tree is deployed at creation time: round 1 first, then each later
// round gated on its feeders having been won. Because round N's entry
// requirement references round N-1's tournament ids, deploy round-by-round —
// create a round, attach its ids, then build the next. Schedules are staggered
// so round N opens only after round N-1's submission window closes.
// ---------------------------------------------------------------------------

/** The two matches whose winners feed into `matchId`, in slot order. */
export function bracketFeeders(state: BracketState, matchId: string): BracketMatch[] {
  return state.matches
    .filter((m) => m.feedsInto === matchId)
    .sort((a, b) => a.indexInRound - b.indexInRound);
}

/** Stagger a round's schedule so it opens after the prior rounds finish. */
function roundSchedule(t: MatchScheduleTemplate, round: number): MatchScheduleTemplate {
  // registrationStartDelay and gameStartDelay are measured from created_at;
  // shift both by the cumulative span of the earlier rounds. The remaining
  // fields are relative durations, so they're unchanged.
  const roundSpan = t.gameStartDelay + t.gameEndDelay + t.submissionDuration;
  const offset = (round - 1) * roundSpan;
  return {
    ...t,
    registrationStartDelay: t.registrationStartDelay + offset,
    gameStartDelay: t.gameStartDelay + offset,
  };
}

/** Build a match's create_tournament Call with staggered schedule + gating. */
function gatedMatchCreateCall(state: BracketState, match: BracketMatch): Call {
  // Round-1 allowlist gating (shared with matchCreateCall): only the match's
  // assigned players can enter, each once. Independent of round>1 feeder gating.
  let entryRequirement: EntryRequirementArgs | undefined = roundOneMerkleRequirement(state, match);
  if (!entryRequirement && state.gated && match.round > 1) {
    const feeders = bracketFeeders(state, match.id);
    const feederIds = feeders.map((f) => f.tournamentId).filter((id): id is string => !!id);
    if (feeders.length === 0 || feederIds.length !== feeders.length) {
      throw new Error(
        `Cannot gate ${match.id}: its feeder match tournaments aren't created yet — deploy round ${match.round - 1} first.`,
      );
    }
    entryRequirement = {
      entryLimit: 1,
      type: {
        kind: "extension",
        address: extensionAddressFor(state.chain, "tournament"),
        config: buildTournamentValidatorConfig({
          requirement: "won",
          tournamentIds: feederIds,
          topPositions: 1,
          qualifyingMode: 0, // AtLeastOne — the winner of either feeder qualifies.
        }),
      },
    };
  }
  const args: CreateTournamentArgs = {
    creatorRewardsAddress: state.creatorRewardsAddress,
    name: `${state.namePrefix} R${match.round}-${match.indexInRound + 1}`.slice(0, 31),
    description: state.description ?? `Bracket ${state.id} - round ${match.round}, match ${match.indexInRound + 1}`,
    gameAddress: state.game,
    settingsId: state.roundSettingsIds?.[match.round - 1] ?? state.settingsId,
    schedule: roundSchedule(state.scheduleTemplate, match.round),
    leaderboard: { ...state.leaderboard },
    ...(entryRequirement ? { entryRequirement } : {}),
  };
  return buildCreateTournamentCall(state.budokanAddress, args);
}

/**
 * Create calls for every (non-bye) match in `round`, with the round's
 * staggered schedule and — for rounds >1 of a gated bracket — the
 * feeder-won entry requirement. Round >1 requires the prior round's
 * tournament ids to be attached already. Run these, then
 * `attachMatchTournament` each resulting id before deploying the next round.
 */
export function roundMatchCreateCalls(
  state: BracketState,
  round: number,
): CreateMatchCall[] {
  return state.matches
    .filter((m) => m.round === round && m.status !== "bye" && !m.tournamentId)
    .map((m) => ({ matchId: m.id, call: gatedMatchCreateCall(state, m) }));
}

/** Number of rounds in the bracket. */
export function bracketRounds(state: BracketState): number {
  return Math.max(...state.matches.map((m) => m.round));
}

/** Configurable per-placement split of a paid bracket's entry fee. */
export interface BracketFeeSplit {
  /** ERC20 token for the entry fee + the prizes it funds. */
  tokenAddress: string;
  /** One player's entry fee, in raw base units (decimal string). */
  fee: string;
  /**
   * Basis points per placement tier (sum ≤ 10000):
   *   [0] champion       → final, position 1
   *   [1] runner-up      → final, position 2
   *   [2] semifinalists  → each semifinal, position 2 (split equally) = 3rd/4th
   *   [3] quarterfinalists → each quarterfinal, position 2 = 5th-8th
   *   …each later index is the losers of one-round-earlier.
   * Tiers deeper than the bracket has rounds are ignored.
   */
  tiersBps: number[];
}

/**
 * The `approve` + `add_prize` calls that escrow ONE player's entry fee as
 * placement prizes across the (already-deployed) bracket matches, per the tier
 * split. The PLAYER signs these from their own session at join time, so the
 * pool is funded non-custodially and grows with each entrant. Winners claim via
 * the normal `claim_reward` flow.
 *
 * Returns [] if nothing would be escrowed (no tiers, or matches not created).
 */
export function bracketFeePrizeCalls(
  state: BracketState,
  split: BracketFeeSplit,
): Call[] {
  const rounds = bracketRounds(state);
  const fee = BigInt(split.fee);
  const prizeCalls: Call[] = [];
  let escrowed = 0n;

  split.tiersBps.forEach((bps, tier) => {
    if (bps <= 0) return;
    const tierAmount = (fee * BigInt(bps)) / 10000n;
    if (tierAmount <= 0n) return;

    // Map the tier to a (round, position) in the tree.
    let round: number;
    let position: number;
    if (tier === 0) {
      round = rounds;
      position = 1; // champion
    } else if (tier === 1) {
      round = rounds;
      position = 2; // runner-up
    } else {
      round = rounds - (tier - 1); // tier 2 → semis, tier 3 → QFs, …
      position = 2; // the losers of that round
    }
    if (round < 1) return;

    const matches = state.matches.filter((m) => m.round === round && m.tournamentId);
    if (matches.length === 0) return;
    const per = tierAmount / BigInt(matches.length);
    if (per <= 0n) return;

    for (const m of matches) {
      prizeCalls.push(
        buildAddPrizeCall(state.budokanAddress, {
          tournamentId: m.tournamentId!,
          prize: {
            kind: "token",
            tokenAddress: split.tokenAddress,
            tokenType: { kind: "erc20", amount: per.toString() },
            position,
          },
        }),
      );
      escrowed += per;
    }
  });

  if (prizeCalls.length === 0) return [];
  // Approve exactly what we escrow (integer division can leave the fee's dust).
  return [
    buildErc20ApproveCall(split.tokenAddress, state.budokanAddress, escrowed.toString()),
    ...prizeCalls,
  ];
}

/**
 * Calls to escrow the configured ERC20 prize on the final match (approve +
 * add_prize at position 1). Empty when no `finalPrize` is set or the final
 * match isn't created yet. The caller (organizer) signs them.
 */
export function bracketFinalPrizeCalls(state: BracketState): Call[] {
  if (!state.finalPrize) return [];
  const final = state.matches.find((m) => !m.feedsInto);
  if (!final?.tournamentId) return [];
  const { tokenAddress, amount } = state.finalPrize;
  return [
    buildErc20ApproveCall(tokenAddress, state.budokanAddress, amount),
    buildAddPrizeCall(state.budokanAddress, {
      tournamentId: final.tournamentId,
      prize: {
        kind: "token",
        tokenAddress,
        tokenType: { kind: "erc20", amount },
        position: 1,
      },
    }),
  ];
}

/**
 * Build the enter call(s) for a player joining their (live) match.
 *
 * For a round-1 merkle-gated match (one with a `roundOneTreeIds` entry), pass
 * `proof` — the allowlist proof span from `getAllowlistProof` — so it's
 * attached as the `QualificationProof::Extension` the merkle validator expects.
 * Gated rounds >1 build their proof internally from the feeder result.
 */
export function bracketEntryCalls(
  state: BracketState,
  matchIdToEnter: string,
  playerAddress: string,
  proof?: string[],
): Call[] {
  const m = findMatch(state, matchIdToEnter);
  if (!m) throw new Error(`Unknown match: ${matchIdToEnter}`);
  if (!m.tournamentId) {
    throw new Error(`Match ${matchIdToEnter} has no tournament yet`);
  }
  // Normalize both sides so a differently-represented `playerAddress`
  // (leading zeros / casing) still matches the stored competitor.
  const wanted = normalizeAddress(playerAddress);
  const player =
    m.playerA && normalizeAddress(m.playerA.address) === wanted
      ? m.playerA
      : m.playerB && normalizeAddress(m.playerB.address) === wanted
        ? m.playerB
        : undefined;
  if (!player) {
    throw new Error(`${playerAddress} is not a competitor in ${matchIdToEnter}`);
  }

  // Gated rounds >1: prove the entrant won the feeder they came from. The proof
  // is QualificationProof::Extension([feederTournamentId, winnerTokenId, 1]) for
  // the tournament validator; the feeder is the player's winning feeder match.
  let qualifier: string | undefined;
  let qualification: { kind: "extension"; data: string[] } | undefined;
  const roundOneTreeId = m.round === 1 ? state.roundOneTreeIds?.[m.id] : undefined;
  if (roundOneTreeId !== undefined) {
    // Round-1 allowlist: prove the entrant is on the match's merkle tree. The
    // proof span comes from the caller (fetched via `getAllowlistProof`). Set
    // `qualifier` to the player so the validator checks THEM against the tree,
    // not the caller — required when someone enters on the player's behalf (the
    // organizer deploying a closed bracket); harmless for self-entry. Mirrors
    // the round>1 branch below.
    if (!proof || proof.length === 0) {
      throw new Error(
        `Match ${matchIdToEnter} is merkle-gated (round-1 allowlist) — pass the proof span from getAllowlistProof(...) as the \`proof\` argument.`,
      );
    }
    qualifier = player.address;
    qualification = { kind: "extension", data: proof };
  } else if (state.gated && m.round > 1) {
    const feeder = bracketFeeders(state, m.id).find(
      (f) => f.winner?.address === player.address,
    );
    if (!feeder?.tournamentId || !feeder.winnerTokenId) {
      throw new Error(
        `Can't build a qualification proof for ${player.address} in ${matchIdToEnter}: ` +
          `their feeder match isn't resolved with a winning token yet.`,
      );
    }
    qualifier = player.address;
    qualification = {
      kind: "extension",
      data: buildTournamentQualificationProof(feeder.tournamentId, feeder.winnerTokenId, 1),
    };
  }

  return [
    buildEnterTournamentCall(state.budokanAddress, {
      tournamentId: m.tournamentId,
      playerAddress: player.address,
      playerName: player.name,
      ...(qualifier ? { qualifier } : {}),
      ...(qualification ? { qualification } : {}),
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
): { winner: BracketPlayer; status: "resolved" | "walkover"; winnerTokenId?: string } {
  const a = match.playerA!;
  const b = match.playerB!;
  const byAddr = new Map(result.ranking.map((r) => [r.address, r]));
  const rowA = byAddr.get(a.address);
  const rowB = byAddr.get(b.address);
  const posA = rowA?.position;
  const posB = rowB?.position;

  if (posA !== undefined && posB !== undefined) {
    const aWins = posA <= posB;
    return {
      winner: aWins ? a : b,
      status: "resolved",
      winnerTokenId: (aWins ? rowA : rowB)?.tokenId,
    };
  }
  if (posA !== undefined) return { winner: a, status: "walkover", winnerTokenId: rowA?.tokenId };
  if (posB !== undefined) return { winner: b, status: "walkover", winnerTokenId: rowB?.tokenId };
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
    const { winner, status, winnerTokenId } = resolveWinner(m, result);
    m.winner = winner;
    m.winnerTokenId = winnerTokenId;
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

// ---------------------------------------------------------------------------
// Bracket grouping (consumer side)
//
// Recognise which tournaments form one bracket and reconstruct the tree — with
// NO extra metadata — by reading the gating that's already on-chain: each
// round>1 match's `entry_requirement` is a tournament_validator extension whose
// config lists the FEEDER tournament ids. The feeder graph IS the bracket, so
// connected components = brackets and the root (no one feeds it) = the final.
// Indexers already expose `entry_requirement` in the tournament list, so this
// is a pure client-side transform — one API query, no extra RPC, no contract
// change. Used by the bot's listing and budokan.gg.
// ---------------------------------------------------------------------------

/** Decoded `tournament_validator` extension config (the gating on a match). */
export interface DecodedTournamentValidator {
  /** 0 = participation, 1 = top-position ("won"). */
  qualifierType: number;
  /** 0 = PER_TOKEN (any one feeder), 1 = ALL. */
  qualifyingMode: number;
  topPositions: number;
  /** The feeder tournament ids (decimal strings). */
  feederTournamentIds: string[];
}

const toDecimal = (felt: string): string => {
  try {
    return BigInt(felt).toString();
  } catch {
    return felt;
  }
};

/**
 * Inverse of `buildTournamentValidatorConfig`: decode the on-chain config span
 * `[qualifierType, qualifyingMode, topPositions, ...feederTournamentIds]` (hex
 * felts, as indexers return them) into its parts. Returns null if malformed.
 */
export function decodeTournamentValidatorConfig(
  config: readonly string[] | null | undefined,
): DecodedTournamentValidator | null {
  if (!config || config.length < 3) return null;
  try {
    return {
      qualifierType: Number(BigInt(config[0]!)),
      qualifyingMode: Number(BigInt(config[1]!)),
      topPositions: Number(BigInt(config[2]!)),
      feederTournamentIds: config.slice(3).map(toDecimal),
    };
  } catch {
    return null;
  }
}

/** A bracket match (a tournament) plus its reconstructed position in the tree. */
export interface BracketMatchNode<T> {
  tournament: T;
  tournamentId: string;
  /** 1-indexed round; leaves (round 1) are ungated, the final is round `rounds`. */
  round: number;
  /** 0-indexed position within the round (by tournament id). */
  matchIndex: number;
  isFinal: boolean;
  /** Feeder tournament ids (empty for round 1). */
  feederTournamentIds: string[];
}

export interface BracketGroup<T> {
  /** Synthetic key: the final (root) tournament id. */
  bracketId: string;
  /** Inferred bracket size = 2^rounds. */
  size: number;
  rounds: number;
  /** Matches present in the input, sorted by (round, matchIndex). */
  matches: Array<BracketMatchNode<T>>;
  /** The final match's tournament, if present in the input. */
  final?: T;
}

/** Minimal shape of an entry requirement, as indexers/the viewer expose it. */
export interface EntryRequirementLike {
  address?: string | null;
  config?: readonly string[] | null;
}

/**
 * Group tournaments into brackets purely from their on-chain gating. For each
 * tournament, `getEntryRequirement` returns its `tournament_validator`
 * extension (address + config) or null; matches with a decodable config form
 * feeder edges, connected components become brackets, and the round of each
 * match is its height above the round-1 leaves. Tournaments not part of any
 * bracket are returned as `standalone`.
 *
 * `validatorAddress` (optional) restricts which extension counts as a bracket
 * gate — pass `extensionAddressFor(chain, "tournament")` to be strict.
 */
export function reconstructBrackets<T>(
  tournaments: readonly T[],
  opts: {
    getId: (t: T) => string;
    getEntryRequirement: (t: T) => EntryRequirementLike | null | undefined;
    validatorAddress?: string;
  },
): { brackets: Array<BracketGroup<T>>; standalone: T[] } {
  const { getId, getEntryRequirement, validatorAddress } = opts;
  const wantAddr = validatorAddress ? toDecimal(validatorAddress) : undefined;

  const byId = new Map<string, T>();
  for (const t of tournaments) byId.set(toDecimal(getId(t)), t);

  // feeders: gated match id -> its feeder ids. allFeeders: every id used as a feeder.
  const feeders = new Map<string, string[]>();
  const allFeeders = new Set<string>();
  for (const t of tournaments) {
    const er = getEntryRequirement(t);
    if (!er?.config) continue;
    if (wantAddr && (!er.address || toDecimal(er.address) !== wantAddr)) continue;
    const decoded = decodeTournamentValidatorConfig(er.config);
    if (!decoded || decoded.feederTournamentIds.length === 0) continue;
    const id = toDecimal(getId(t));
    feeders.set(id, decoded.feederTournamentIds);
    for (const f of decoded.feederTournamentIds) allFeeders.add(f);
  }
  if (feeders.size === 0) return { brackets: [], standalone: [...tournaments] };

  // Union-find over all participating ids (gated matches + their feeders).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    if (!parent.has(x)) parent.set(x, x);
    while (r !== parent.get(r)) {
      const gp = parent.get(parent.get(r)!)!;
      parent.set(r, gp);
      r = gp;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };
  for (const [id, fids] of feeders) for (const f of fids) union(id, f);

  // round(id) = height above the leaves (memoised; feeder graph is a DAG).
  const roundMemo = new Map<string, number>();
  const roundOf = (id: string, guard = 0): number => {
    if (roundMemo.has(id)) return roundMemo.get(id)!;
    const fids = feeders.get(id);
    const r = fids && fids.length && guard < 64 ? 1 + Math.max(...fids.map((f) => roundOf(f, guard + 1))) : 1;
    roundMemo.set(id, r);
    return r;
  };

  const participants = new Set<string>([...feeders.keys(), ...allFeeders]);
  const components = new Map<string, string[]>();
  for (const id of participants) {
    const root = find(id);
    const arr = components.get(root);
    if (arr) arr.push(id);
    else components.set(root, [id]);
  }

  const brackets: Array<BracketGroup<T>> = [];
  const grouped = new Set<string>();
  for (const ids of components.values()) {
    const rounds = Math.max(...ids.map((id) => roundOf(id)));
    // The final is the root: at max round and never used as a feeder.
    const finalId = ids.find((id) => roundOf(id) === rounds && !allFeeders.has(id)) ?? ids.find((id) => roundOf(id) === rounds);
    // matchIndex: stable order within each round, by numeric id.
    const matchIndex = new Map<string, number>();
    const byRound = new Map<number, string[]>();
    for (const id of ids) {
      const r = roundOf(id);
      const arr = byRound.get(r);
      if (arr) arr.push(id);
      else byRound.set(r, [id]);
    }
    for (const list of byRound.values()) {
      list.sort((a, b) => {
        // ids are normally decimal strings; fall back to lexical if a custom
        // id isn't BigInt-parseable so a bad id can't crash grouping.
        try {
          const ab = BigInt(a);
          const bb = BigInt(b);
          return ab < bb ? -1 : ab > bb ? 1 : 0;
        } catch {
          return a < b ? -1 : a > b ? 1 : 0;
        }
      });
      list.forEach((id, i) => matchIndex.set(id, i));
    }
    const matches = ids
      .filter((id) => byId.has(id))
      .map((id) => ({
        tournament: byId.get(id)!,
        tournamentId: id,
        round: roundOf(id),
        matchIndex: matchIndex.get(id) ?? 0,
        isFinal: id === finalId,
        feederTournamentIds: feeders.get(id) ?? [],
      }))
      .sort((a, b) => a.round - b.round || a.matchIndex - b.matchIndex);
    if (matches.length === 0) continue;
    for (const m of matches) grouped.add(m.tournamentId);
    brackets.push({
      bracketId: finalId ?? matches[matches.length - 1]!.tournamentId,
      size: 2 ** rounds,
      rounds,
      matches,
      final: finalId ? byId.get(finalId) : undefined,
    });
  }
  const standalone = tournaments.filter((t) => !grouped.has(toDecimal(getId(t))));
  return { brackets, standalone };
}
