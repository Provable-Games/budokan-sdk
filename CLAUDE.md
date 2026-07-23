# Budokan SDK — Development Guide

## Package Manager

**CRITICAL: Always use `bun`, never `npm`, `yarn`, or `pnpm`.** This project uses `bun.lock` as the single lockfile. Do not run `npm install`, `npm ci`, or any npm commands that manage dependencies. Do not generate `package-lock.json`.

## Commands

```bash
bun install          # Install dependencies
bun run build        # Build ESM + CJS to dist/
bun run typecheck    # TypeScript type checking (tsc --noEmit)
bun run dev          # Build in watch mode
bun run clean        # Remove dist/
```

## Reference Examples

```
examples/
├── telegram-tournament-bot.mjs          # Dependency-free Telegram tournament bot reference
├── telegram-tournament-bot.md           # End-to-end setup, testing, and deployment guide
├── telegram-tournament-bot.env.example  # Optional environment variables
└── mcp-server/                          # MCP server: agent-driven reads + tournament creation
```

The MCP server (`examples/mcp-server/`) exposes SDK reads plus signed `create_tournament` / `add_prize` writes to MCP-capable agents, with an optional generated dev wallet (key stored in a 0600 keystore, never surfaced through tool I/O). Like the bots, it drives the chain exclusively through the SDK's public calldata builders. Verify with `bun run typecheck` and `bun smoke.mjs` in that directory.

The Telegram bot is a reference implementation for downstream developers and AI agents. Keep it self-contained, readable, and documented. It demonstrates SDK usage through public APIs (`getTournament`, `getTournamentLeaderboard`, `getTournamentPrizes`, `getTournaments`) and WebSocket subscriptions filtered by `tournamentIds`, without changing SDK internals under `src/`. The Budokan SDK is read-only — actions that require signing (entering, submitting, claiming) are surfaced as deeplinks to the Budokan web app instead of being implemented inside the bot.
