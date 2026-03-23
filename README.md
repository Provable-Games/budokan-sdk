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

The SDK monitors API and RPC health in the background. When the API goes down, methods with RPC fallback automatically switch to direct contract calls. When the API recovers, it switches back.

| Method | API | RPC | Fallback |
|--------|-----|-----|----------|
| `getTournaments(params?)` | Yes | Yes | Yes |
| `getTournament(id)` | Yes | Yes | Yes |
| `getTournamentLeaderboard(id)` | Yes | Yes | Yes |
| `getTournamentRegistrations(id)` | Yes | Yes | Yes |
| `getTournamentPrizes(id)` | Yes | Yes | Yes |
| `getGameTournaments(addr)` | Yes | Yes | Yes |
| `getTournamentRewardClaims(id)` | Yes | — | API only |
| `getTournamentRewardClaimsSummary(id)` | Yes | — | API only |
| `getTournamentQualifications(id)` | Yes | — | API only |
| `getTournamentPrizeAggregation(id)` | Yes | — | API only |
| `getPlayerTournaments(addr)` | Yes | — | API only |
| `getPlayerStats(addr)` | Yes | — | API only |
| `getGameStats(addr)` | Yes | — | API only |
| `getActivity(params?)` | Yes | — | API only |
| `getActivityStats()` | Yes | — | API only |
| `getPrizeStats()` | Yes | — | API only |

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
npm install
npm run build        # ESM + CJS to dist/
npm run typecheck    # TypeScript validation
npm run dev          # Watch mode
```

## Publishing

Publishing is automated via GitHub Actions. To release:

1. Bump the version in `package.json`
2. Create a GitHub Release (e.g. `v0.1.0`)
3. The `publish.yml` workflow runs typecheck, build, and publishes to npm

Requires an `NPM_TOKEN` secret configured in the repo settings.

## License

MIT
