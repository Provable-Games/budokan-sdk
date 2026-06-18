# 1v1 Brackets — Off-chain orchestration over leaderboard tournaments

## Problem

Budokan is **leaderboard-only**: a tournament collects entries, each entry plays
the game once and submits a score, and the contract ranks them. There is no
on-chain notion of head-to-head matches, rounds, seeding, or elimination.

A "1v1 bracket" (single-elimination) needs exactly those notions. Per the
agreed approach we build them **off-chain in the SDK**, orchestrating a set of
ordinary budokan tournaments — no Cairo changes.

## Core mapping

> **One match = one 2-player leaderboard tournament.**

Each bracket match is a short budokan tournament for the chosen game, with the
two competitors as its only registrants. The match winner is whoever ranks #1 on
that tournament's leaderboard once its submission window closes (respecting the
game's `leaderboardAscending`). The bracket coordinator advances winners into the
next round by creating the next round's match tournaments.

Why per-match tournaments and not one shared tournament: a bracket requires
players to compete **head-to-head, round by round**, with elimination between
rounds. A single leaderboard tournament collapses everyone into one ranking with
one submission each — it can't express "A beats B in round 1, then plays the
winner of C vs D". The per-match mapping is the only faithful reduction onto the
existing primitive.

## Bracket lifecycle

```
createBracket(players, game, opts)
        │  seed players, compute round-1 pairings (+byes)
        ▼
  round 1: create N match tournaments  ──► players enter + play + submit_score
        │
        ▼
  advanceBracket(state, reads)   ◄── poll: which matches have resolved?
        │  resolve winners from each finished match's leaderboard
        │  when a full round is resolved → create next round's matches
        ▼
       ... repeat ...
        ▼
      final match resolved → champion
```

### Data model (serializable, storage-agnostic)

The SDK owns bracket *logic* and *state shape* but **not persistence** — it
returns plain JSON-serializable objects. The bot persists them in its existing
`session-store`; another consumer could use a DB.

```ts
type MatchStatus = "pending" | "live" | "resolved" | "bye" | "walkover";

interface BracketMatch {
  id: string;              // `${bracketId}-r${round}-m${index}`
  round: number;           // 1-based
  indexInRound: number;
  playerA?: BracketPlayer; // undefined until the feeding match resolves
  playerB?: BracketPlayer;
  tournamentId?: string;   // the on-chain match tournament (once created)
  status: MatchStatus;
  winner?: BracketPlayer;
  feedsInto?: string;      // next-round match id (undefined for the final)
}

interface BracketPlayer { address: string; name?: string; seed: number; }

interface BracketState {
  id: string;
  game: string;            // game contract address
  chain: WhitelistChain;
  settingsId: number;
  scheduleTemplate: MatchScheduleTemplate; // per-match durations
  size: number;            // bracket slots (next pow2 ≥ players.length)
  players: BracketPlayer[];
  matches: BracketMatch[]; // full tree, flattened
  status: "registering" | "running" | "complete";
  champion?: BracketPlayer;
}
```

## Decisions

- **Format:** single-elimination first. The match-tree representation leaves room
  for double-elim (losers' bracket) later, but it's out of scope for v1.
- **Seeding:** caller-provided order = seeds (seed 1 strongest). A `random` option
  shuffles. Standard seed pairing (1vN, 2v(N-1)…) so byes land on top seeds.
- **Byes:** when `players.length` isn't a power of two, the top
  `2^ceil - players.length` seeds get round-1 byes (auto-`resolved`, no
  tournament created).
- **Winner resolution:** read the match tournament's leaderboard (`viewerLeaderboard`,
  position 1 = winner) and map the winning `tokenId` → player via the match's
  registrations. Resolution only happens once the match has reached `submission`/
  finished state (reuse the viewer's tournament-state derivation).
- **No-show / walkover:** if only one competitor submits, they advance
  (`walkover`). If neither submits by window close, the **higher seed** advances
  (configurable: `both-eliminated` would break the tree, so seed-advance is the
  safe default).
- **Ties:** leaderboard position is authoritative; if the contract ranks them
  equal (shouldn't happen for distinct token ids), the higher seed advances.
- **Spin-up:** `advanceBracket` is **pure** — it takes current state + a reader
  callback and returns `{ nextState, callsToCreateMatches }` (an array of
  `Call`s built with `buildCreateTournamentCall`). The caller signs/executes and
  feeds the resulting tournament ids back via `attachMatchTournament`. This keeps
  the module decoupled from how accounts sign (same principle as `src/calldata`).

## Public surface (proposed)

```ts
createBracket(opts): BracketState
bracketEntryCalls(state, matchId, player): Call[]      // enter a player into their match
advanceBracket(state, read): Promise<{ state; createCalls: CreateMatchCall[] }>
attachMatchTournament(state, matchId, tournamentId): BracketState
nextMatchesFor(state, address): BracketMatch[]          // "where do I play next?"
bracketSummary(state): string                           // ASCII tree for chat/UI
```

`read` is `(tournamentId) => Promise<{ state; leaderboard; registrations }>`,
satisfiable from the existing RPC viewer — the SDK ships a default reader built
from a `BudokanClient`, but callers can inject their own.

## Telegram `/bracket` flow (consumer)

1. `/bracket` → pick game (whitelist picker, reuses `/create` UI), set player
   count / paste player handles, pick per-match duration → confirm.
2. Bot calls `createBracket`, persists state, posts the seeded tree.
3. Bot runs `advanceBracket` on a timer (Railway cron / interval); creates the
   round's match tournaments via the connected Controller account, DMs each
   player a deep link to enter + play their match.
4. As matches resolve, bot posts updated bracket; on the final, announces the
   champion and (optionally) routes prize payout.

## Open questions for product

- Prize handling: pooled at the bracket level (winner-takes-all via the final
  match's prize) vs per-match? v1 assumes the bracket champion is decided
  off-chain and any prize is attached to the final match tournament.
- Match scheduling: fixed per-match window vs. waiting for both players to be
  ready. v1 uses a fixed window from the schedule template.
```
