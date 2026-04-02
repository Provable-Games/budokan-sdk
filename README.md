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
