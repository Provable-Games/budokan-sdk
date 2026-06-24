# Budokan Telegram tournament bot

A dependency-free reference bot showing how to drive the **read side** of
`@provable-games/budokan-sdk` from a plain Node process: browse tournaments,
leaderboards and prizes, and stream live updates over the SDK's WebSocket.

It is intentionally **read-only**. Anything that needs a signature — entering a
tournament, submitting a score, claiming a prize — is handed off as a deeplink
to the [Budokan web app](https://budokan.gg), where the user signs with their
own wallet. **The bot never holds keys.**

- Single file: [`telegram-tournament-bot.mjs`](./telegram-tournament-bot.mjs)
- No npm dependencies — only Node built-ins (`fetch`, global `WebSocket`) plus
  the Budokan SDK in this repo.
- Requires **Node ≥ 22** (stable global `WebSocket`).

## What it demonstrates

| SDK surface | Used for |
|---|---|
| `createBudokanClient({ chain })` | one client, chain preset resolves API/WS/addresses |
| `client.getTournaments({ limit, sort })` | `/tournaments` |
| `client.getTournament(id)` | `/tournament <id>` (incl. the SDK-derived `phase`) |
| `client.getTournamentLeaderboard(id)` | `/leaderboard <id>` |
| `client.getTournamentPrizes(id)` | `/prizes <id>` |
| `client.connect()` + `client.subscribe(channels, handler, [id])` | `/watch <id>` live updates |
| `tournamentPageUrl(chain, id)` | `/enter`, `/claim`, `/create` deeplinks |

## Commands

```
/tournaments        latest tournaments
/tournament <id>    details for one tournament
/leaderboard <id>   current standings
/prizes <id>        prize pool
/watch <id>         live updates in this chat (registrations, prizes, claims)
/unwatch <id>       stop live updates
/enter <id>         deeplink to enter (sign in the app)
/claim <id>         deeplink to claim prizes (sign in the app)
/create             deeplink to create a tournament
/help               this list
```

## Setup

1. **Create a bot** with [@BotFather](https://t.me/BotFather) → `/newbot`. Copy
   the token it gives you.
2. **Configure** — copy the example env and fill it in:
   ```bash
   cp examples/telegram-tournament-bot.env.example .env
   # edit .env: set TELEGRAM_BOT_TOKEN, optionally BUDOKAN_CHAIN=sepolia
   ```
3. **Build the SDK** (the bot imports the built `dist/`):
   ```bash
   bun install
   bun run build
   ```
4. **Run** (Node ≥ 22):
   ```bash
   set -a; source .env; set +a
   node examples/telegram-tournament-bot.mjs
   ```
   You should see `Bot started on chain "mainnet". Polling for updates…`.

## Testing

- DM your bot `/help`, then `/tournaments`.
- Pick an id from that list and try `/tournament <id>`, `/leaderboard <id>`,
  `/prizes <id>`.
- `/watch <id>` then trigger an entry/prize/claim on that tournament (e.g. via
  the web app) — you should get a live message in the chat. `/unwatch <id>` to
  stop.
- `/enter <id>` should reply with a `budokan.gg` deeplink, not a transaction.

Tip: for faster iteration use `BUDOKAN_CHAIN=sepolia` and a sepolia tournament.

## Deployment

The bot is a long-running process that long-polls Telegram (no public URL or
webhook required), so any always-on host works:

```Dockerfile
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm i -g bun && bun install && bun run build
CMD ["node", "examples/telegram-tournament-bot.mjs"]
```

Set `TELEGRAM_BOT_TOKEN` (and optionally `BUDOKAN_CHAIN`) in the host's
environment. The process exits cleanly on `SIGINT`/`SIGTERM` (unsubscribes WS
watchers and tears down the client), so it restarts safely.

## Notes & limits

- **Read-only by design.** Adding signing would mean custodying keys or running
  a session/paymaster flow — out of scope for a reference. Deeplinks keep the
  user in control of their wallet.
- **Single-process state.** `/watch` subscriptions live in memory; they reset on
  restart. A production bot would persist them.
- Leaderboard rows show the game **token id** (the SDK read path is wallet-less);
  resolving token → owner/username is a separate concern (denshokan + Cartridge).
- The bot reads through the SDK's API path with automatic RPC fallback — see the
  SDK README for configuring `primarySource`/`rpcUrl` if you want RPC-only.
