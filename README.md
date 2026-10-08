# @provable-games/budokan-sdk

TypeScript SDK for [Budokan](https://github.com/Provable-Games/budokan) — query and manage tournaments via REST API and Starknet RPC with automatic fallback.

## Features

- **Dual data source** — API-first with automatic RPC fallback when the indexer is unavailable
- **Health monitoring** — Background `ConnectionStatus` service tracks API/RPC availability and auto-switches modes
- **React hooks** — Provider, data hooks, and WebSocket subscriptions out of the box
- **WebSocket subscriptions** — Real-time tournament updates with auto-reconnect
- **ESM + CJS** — Dual build with full TypeScript declarations
- **camelCase types** — All public types use camelCase field names

## Install

```bash
npm install @provable-games/budokan-sdk
# or
pnpm add @provable-games/budokan-sdk
```

**Peer dependencies** (install if you need their features):

```bash
npm install starknet    # Required for RPC calls
npm install react       # Required for React hooks
```

## Quick Start

### Basic Client

```ts
import { createBudokanClient } from "@provable-games/budokan-sdk";

const client = createBudokanClient({
  chain: "mainnet",
});

// Fetch tournaments from API
const { data: tournaments } = await client.getTournaments();
console.log(tournaments[0].id, tournaments[0].name);

// Fetch a single tournament (API with automatic RPC fallback)
const tournament = await client.getTournament("42");
console.log(tournament.name, tournament.entryCount);

// Fetch leaderboard
const leaderboard = await client.getTournamentLeaderboard("42");
```

### React

```tsx
import { BudokanProvider, useTournaments, useTournament } from "@provable-games/budokan-sdk/react";

function App() {
  return (
    <BudokanProvider
      config={{
        chain: "mainnet",
      }}
    >
      <TournamentList />
    </BudokanProvider>
  );
}

function TournamentList() {
  const { data, isLoading, error } = useTournaments();

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <ul>
      {data?.data.map((t) => (
        <li key={t.id}>{t.name}</li>
      ))}
    </ul>
  );
}
```

### WebSocket Subscriptions

```tsx
import { useSubscription } from "@provable-games/budokan-sdk/react";

function TournamentFeed({ tournamentId }: { tournamentId: string }) {
  useSubscription(
    ["registration", "submission"],
    (message) => {
      console.log("Event:", message.channel, message.data);
    },
    [tournamentId],
  );

  return <div>Listening for tournament updates...</div>;
}
```

### Game-token leaderboard order

For schema-1 game-token IDs, sort with `compareGameTokenScores(a, b, ascending)`
before capping the list or passing IDs to `getSubmittableScores`. Equal scores
prefer the earlier `minted_at_block_number`; same-block ties use the lower
numerical token ID. Use bigint or decimal-string scores to preserve the full on-chain u64 range.
Unsafe JavaScript number scores are rejected. Bracket schedules reserve the
contract's minute-alignment delay so a later round does not open before its
feeders' full submission windows close.

### Whitelisted Games

The SDK ships a curated per-chain list of games and per-game UX metadata
(homepage URLs, default entry-fee token, controller-only flag, etc.) that
the official Budokan client uses to filter the on-chain denshokan registry.
Other integrations — Telegram bot, third-party UIs — can use the same
list to stay consistent.

```ts
import {
  getWhitelistedGames,
  findWhitelistedGame,
  isGameWhitelisted,
  getGameDefaults,
} from "@provable-games/budokan-sdk";

// Sorted by name, disabled entries last
const games = getWhitelistedGames("mainnet");
// → [{ contractAddress: "0x4de0...", name: "Death Mountain", url: "...", ... }, ...]

const dm = findWhitelistedGame("mainnet", "0x4de0351c..."); // address auto-normalized
const ok = isGameWhitelisted("sepolia", anyAddress);

// Defaults block — falls back to STRK / 1% / $0.25 when the game isn't whitelisted
const { minEntryFeeUsd, defaultEntryFeeToken, defaultGameFeePercentage } =
  getGameDefaults("mainnet", gameAddress);
```

The denshokan registry is still the source of truth for which games *exist*;
this whitelist is a layer on top that callers can intersect with the
registry to filter to "games we trust + display metadata for."

### Telegram Tournament Bot Example

This repo includes a dependency-free Telegram bot example that lets a chat follow Budokan tournaments and receive live updates as registrations, scores, prizes, and reward claims land.

```bash
bun run build
TELEGRAM_BOT_TOKEN=123456789:your-token node examples/telegram-tournament-bot.mjs
```

In Telegram:

```text
/follow 42
/tournament 42
/leaderboard 42
/play 42
```

Full setup, testing, and deployment instructions are in `examples/telegram-tournament-bot.md`. Optional environment variables are listed in `examples/telegram-tournament-bot.env.example`. The bot persists chat follows in `.telegram-tournament-bot-registrations.json` by default. Tournament actions (entering, submitting a score, claiming a prize) are surfaced as deeplinks back to `https://budokan.gg` so the user signs with their Cartridge wallet in the browser.

## Configuration

```ts
interface BudokanClientConfig {
  chain?: "mainnet" | "sepolia";       // Default: "mainnet"
  apiBaseUrl?: string;                  // REST API base URL
  wsUrl?: string;                       // WebSocket URL
  rpcUrl?: string;                      // Custom Starknet RPC endpoint
  provider?: RpcProvider;               // starknet.js provider (takes precedence over rpcUrl)
  viewerAddress?: string;               // BudokanViewer contract address
  budokanAddress?: string;              // Budokan contract address
  primarySource?: "api" | "rpc";        // Default: "api"
  retryAttempts?: number;               // Default: 3
  retryDelay?: number;                  // Default: 1000ms
  timeout?: number;                     // Default: 10000ms
}
```

## Data Source Fallback

The SDK supports two data sources: **API** (REST indexer) and **RPC** (direct Starknet contract calls via BudokanViewer). Set `primarySource: "api"` (default) or `primarySource: "rpc"` in config. When the API goes down, methods with RPC support automatically fall back to direct contract calls.

### Feature Support

| Method | API | RPC | Notes |
|--------|:---:|:---:|-------|
| **Tournaments** | | | |
| `getTournaments(params?)` | ✅ | ✅ | RPC groups phases: `scheduled` includes Scheduled+Registration+Staging, `live` includes Live+Submission |
| `getTournament(id)` | ✅ | ✅ | |
| `getTournamentLeaderboard(id)` | ✅ | ✅ | |
| `getTournamentRegistrations(id)` | ✅ | ✅ | RPC: `playerAddress` and `gameAddress` fields will be empty |
| `getTournamentPrizes(id)` | ✅ | ✅ | |
| `getGameTournaments(addr)` | ✅ | ✅ | |
| **Brackets** | | | |
| `getBrackets(params?)` | ✅ | ✅ | RPC scans `BracketCreated` from `bracketStartBlock` and reads each bracket at one block |
| `getBracket(id)` | ✅ | ✅ | Also asks the chain when the API has not indexed the bracket yet (404) |
| `getBracketRegistrations(id)` / `getPlayerBracketRegistrations(addr)` | ✅ | ❌ | API only — registrations are indexed from events |
| **Prize Aggregation** | | | |
| `getTournamentPrizeAggregation(id)` | ✅ | ❌ | API only |
| `includePrizeSummary` param | ✅ | ✅ | RPC fetches prizes per tournament and builds aggregation client-side |
| **Rewards** | | | |
| `getTournamentRewardClaims(id)` | ✅ | ✅ | RPC checks `is_prize_claimed` per prize via viewer |
| `getTournamentRewardClaimsSummary(id)` | ✅ | ✅ | RPC returns totals from viewer |
| `getTournamentQualifications(id)` | ✅ | ⚠️ | On-chain via `get_qualification_entries` — requires proof input, not yet wired |
| **Players** | | | |
| `getPlayerTournaments(addr)` | ✅ | ✅ | RPC iterates tournaments and checks entry ownership via ERC721 |
| `getPlayerStats(addr)` | ✅ | ❌ | API only — requires aggregated stats |
| **Games** | | | |
| `getGameStats(addr)` | ✅ | ❌ | API only — requires aggregated stats |
| **Activity** | | | |
| `getActivity(params?)` | ✅ | ❌ | API only — activity is indexed from events |
| `getActivityStats()` | ✅ | ❌ | API only — requires aggregated stats |
| `getPrizeStats()` | ✅ | ❌ | API only — requires aggregated stats |
| **WebSocket** | | | |
| `subscribe(channels, handler)` | ✅ | ❌ | Requires API WebSocket server |

### RPC Behaviour

When `primarySource: "rpc"`:
- All tournament queries go directly to the **BudokanViewer** contract — no API calls
- Phase filtering uses `tournaments_by_phases` for grouped queries (e.g., "scheduled" queries 3 phases in 1 RPC call)
- Prize aggregation for tournament cards is built client-side from per-tournament prize data
- API-only methods will throw an error — they require the indexed API
- Stale data is automatically cleared when switching networks

## API Reference

### Client Methods

**Tournaments** — `getTournaments(params?)`, `getTournament(id)`, `getTournamentLeaderboard(id)`, `getTournamentRegistrations(id, params?)`, `getTournamentPrizes(id)`

**Rewards & Qualifications** — `getTournamentRewardClaims(id, params?)`, `getTournamentRewardClaimsSummary(id)`, `getTournamentQualifications(id, params?)`, `getTournamentPrizeAggregation(id)`

**Players** — `getPlayerTournaments(address, params?)`, `getPlayerStats(address)`

**Games** — `getGameTournaments(gameAddress, params?)`, `getGameStats(gameAddress)`

**Activity** — `getActivity(params?)`, `getActivityStats()`, `getPrizeStats()`

**WebSocket** — `connect()`, `disconnect()`, `subscribe(channels, handler, tournamentIds?)`, `onWsConnectionChange(listener)`

**Utilities** — `getConnectionStatus()`, `onConnectionStatusChange(listener)`, `destroy()`

### React Hooks

All data hooks return `{ data, isLoading, error, refetch }`.

**Data** — `useTournaments(params?)`, `useTournament(id)`, `useLeaderboard(tournamentId)`, `usePlayerTournaments(address, params?)`, `usePlayerStats(address)`, `usePlayer(address)`

**Rewards & Prizes** — `useRewardClaims(tournamentId)`, `useRewardClaimsSummary(tournamentId)`, `usePrizes(tournamentId)`, `usePrizeStats()`, `useQualifications(tournamentId)`

**WebSocket** — `useSubscription(channels, handler, tournamentIds?)`

**Context** — `useBudokanClient()`, `useConnectionStatus()`

## Error Handling

```ts
import { BudokanError, BudokanApiError, DataSourceError } from "@provable-games/budokan-sdk";

try {
  const tournament = await client.getTournament("42");
} catch (error) {
  if (error instanceof DataSourceError) {
    console.log("Primary failed:", error.primaryError.message);
    console.log("Fallback failed:", error.fallbackError.message);
  } else if (error instanceof BudokanApiError) {
    console.log("HTTP status:", error.statusCode);
  }
}
```

Error classes: `BudokanError`, `BudokanApiError`, `BudokanTimeoutError`, `BudokanConnectionError`, `TournamentNotFoundError`, `RpcError`, `DataSourceError`.

## Development

```bash
bun install
bun run build        # ESM + CJS to dist/
bun run typecheck    # TypeScript validation
bun run dev          # Watch mode
```

## Publishing

Publishing is automated via GitHub Actions. To release:

1. Bump the version in `package.json`
2. Create a GitHub Release (e.g. `v0.1.0`)
3. The `publish.yml` workflow runs typecheck, build, and publishes to npm

Requires an `NPM_TOKEN` secret configured in the repo settings.

## License

MIT

## Current game-token contract migration

Version 0.4.0 is a breaking write-ABI update. The calldata builders target the new Budokan deployment in
[Budokan #331](https://github.com/Provable-Games/budokan/pull/331).
`CreateTournamentArgs` and `EnterTournamentArgs` remove `salt` and
`metadataValue`; entry arguments also remove `playerName`. These builders require
that deployment and are incompatible with older Budokan write entrypoints.
Tournament metadata (name/description) and off-chain bracket display names remain.

Use `buildEnterTournamentForRecipientsCall` for multiple entries into the same
tournament in one transaction. Its recipients contain `playerAddress`, `qualifier`
and `qualification`. A recipient may appear more than once. Mint nonces are local
to a mint call: execute at most one entry mint call per tournament per transaction,
and use separate transactions for additional batches. The 2,048-recipient encoding
limit does not guarantee that a batch fits Starknet's runtime limits.

The repository examples depend on this checkout. Build the root SDK with
`bun run build` before installing or type-checking an example.
Bot users must reconnect to authorize the batch-entry session permission.

### Automatic completion after all entries submit

Updated Budokan contracts can finish the submission grace period as soon as
all registered entries are ranked. Gameplay must have ended and the registered
entry count must be nonzero. Completion uses the existing registration and
leaderboard counts; creators do not configure a target or opt in.

Prizes and entry-fee rewards become claimable immediately. Claims remain
separate transactions. Empty tournaments and partial submissions retain the
normal scheduled finalization. Gameplay durations, bracket round start times,
and client day-long creation defaults remain unchanged.

Every registered entry must be ranked. The existing leaderboard overwrites
occupied ranks rather than shifting entries down: if a new score displaces an
earlier entry, restore it at the correct rank. Submitting in ranking order
avoids the extra placement transaction.

Tournament reads honor the API's indexed `phase` and the RPC viewer's
authoritative `phase`, including automatic completion during the grace period.
The updated Budokan indexer snapshots active leaderboard length after every
submission, including re-submissions; historical `submissionCount` is not a
completion signal. Refetch after indexing to observe a changed phase. Older
API/viewer responses retain the schedule-based fallback. The pure
`tournamentPhase` helper computes scheduled time only. No contract deployment
or SDK publication is included.


## Multiple attempts in SDK brackets

Set `attemptsPerPlayer` on `createBracket` or `createRegisteringBracket` to give
both competitors the same allowance in every round. It defaults to `1`, including
when restoring an older saved bracket without the field. This is a best-score
format: the entry at leaderboard position **1** qualifies its owner, irrespective
of how many other entries that player has. Scores are not added together.

```ts
import {
  createBracket, bracketRoundOneAllowlistCall, attachRoundOneTree,
  bracketEntryCalls,
} from "@provable-games/budokan-sdk";

const state = createBracket({ ...bracketOptions, attemptsPerPlayer: 2 });
const match = state.matches.find((m) => m.round === 1)!;
const tree = bracketRoundOneAllowlistCall(state, match.id);
// Sign tree.call, parse its treeId, and store tree.entries via storeAllowlistTree.
// Each player's immutable leaf count is 2, matching the tournament entry limit.
attachRoundOneTree(state, match.id, treeId);
// Repeat for each first-round match, then create/attach tournaments as usual.

// After the match tournament exists, fetch this player's allowlist proof.
const calls = bracketEntryCalls(state, match.id, playerAddress, proof, 2);
// One enter_tournament_for_recipients call mints both attempts safely.
// Omit the last argument to mint one attempt at a time.
```

Values must be integers from 1 through `MAX_ALLOWLIST_ENTRY_COUNT` (2,147,483,647).
A single mint batch is limited to 2,048 entries. The pure entry builder does not
read remaining allowance; check `entries_left` before signing. Every attempt is
a separate game entry and incurs any applicable game-entry costs.

For multiple attempts, the builder requires `gated: true` and attached first-round
allowlist trees. Use the helper above: attaching an existing tree with smaller
leaf counts cannot increase those immutable allowances. Both upfront and
incremental match creation retain the quota and top-one qualifier in later rounds.
One qualifying winning token grants the configured number of next-round attempts.

Both SDK creation paths support attempt quotas; the on-chain path requires the
updated bracket deployment described below. Bots and clients must opt in and
handle remaining attempts; an SDK update does not change existing tournaments. Late submissions
can still change first place after finalization; this option does not lock a winner.


### On-chain random-draw brackets

`buildCreateBracketCall(address, config)` retains opt-in paid or free registration.
Use `buildBracketRegisterCalls` to approve an entry fee and register, optionally
restricting eligibility with the contract's registration allowlist. `requireFull`
requires a fixed field to fill; otherwise underfilled registration draws the
largest filled power of two and refunds excluded paid entrants. Fields support
up to 1,024 players. Set `attemptsPerPlayer` for the immutable per-round quota and
`setupWindow` for a buffered match build. Omitting these options preserves the
legacy creation ABI.

For a free roster supplied by the creator, use `buildCreateFreeRosterCall(address,
config)` followed by `buildImportFreeRosterCall(address, id, confirmedCount,
players)`. Each batch contains 1..256 unique, nonzero addresses. Read the confirmed
`registrant_count` before the next batch; never resend an uncertain transaction.
Paid entries and ordinary registration are rejected in this mode, and the full
fixed roster is required before drawing. `is_free_roster(id)` identifies the mode.

Call `buildBracketCloseCall` when registration can close. Closing freezes the
roster and commits the next block's hash; wait until the onchain
`assignment_ready` view is true before `buildBracketAssignmentCall`. A migrated
ASSIGNING bracket without a commitment uses `buildBracketCommitCall` once.
The current stack needs no Cartridge VRF service or VRF session. The deprecated
`buildBracketSeedCalls` helper is only for historical VRF deployments.

Use `buildBracketMatchesCall(address, id, max)` in bounded resumable batches until
RUNNING. Players mint their own game attempts; setup never premints their games.
The first-round Merkle leaves and later-round winner gates share the configured
quota. Only the feeder's first-place qualifying token grants the next round's
allowance, which is bound on first advancement. Multiple attempts require
winner-take-all escrow prizes because placements rank game tokens.

Creation checks the current game-token interface and settings before fees can be
accepted. New paid brackets always have a setup recovery window. If dependencies
change and the first match cannot be built, `buildBracketStartRecoveryCall` calls
`build_matches(id, 0)` to anchor that window without invoking match creation.
After expiry, an incomplete setup can be cancelled and all outstanding entry fees
refunded to their original payers. Existing zero-window terms are unchanged.
`deployment()` reports Budokan, the legacy VRF target, winner validator and Merkle
validator; verify the selected stack before writing.

### Large fixed fields and batched invitations

Fixed onchain fields support powers of two up to `MAX_BRACKET_FIELD` (8,192).
`size: 0` remains deadline-sized, capped at `MAX_OPEN_BRACKET_FIELD` (1,024).
Use `buildCreateBracketWithAllowlistCall(address, config, expectedCount)` to lock
registrations atomically with creation. Then import at most
`BRACKET_IMPORT_BATCH` (256) unique addresses per call using
`buildImportRegistrationAllowlistCall`. Read `registration_allowlist_progress`
after each confirmed transaction and resume from its `imported` cursor; do not
advance based on a broadcast alone. Finish with
`buildFinalizeRegistrationAllowlistCall` once every invitation is confirmed.
An existing empty bracket can start this process with
`buildBeginRegistrationAllowlistCall`. The creator performs these uploads;
invited players still register themselves and pay their own fee.

`decodeRegistrationAllowlistProgress` validates the three-felt response; `ready`
must be true before players register or a bot closes registration. Older atomic
allowlists remain compatible. Creator-supplied **free rosters** use
`buildCreateFreeRosterCall` and `buildImportFreeRosterCall` instead, bypassing
registration without charging anyone.

Fields above 1,024 also draw in bounded chunks. Read `assignment_progress`, decode
with `decodeBracketAssignmentProgress`, then repeat `buildBracketAssignmentCall`
after confirmation until the contract leaves ASSIGNING. All chunks use the same
committed blockhash seed. Give transaction journals a distinct action key per
confirmed `completed` cursor. Match creation still uses bounded
`buildBracketMatchesCall` calls. No helper auto-mints tournament attempts.

These methods require the scaled bracket class from
[Budokan PR #348](https://github.com/Provable-Games/budokan/pull/348).
