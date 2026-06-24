# Telegram Controller Bot

A Telegram bot that lets users create, enter, and claim Budokan tournaments entirely from inside Telegram, using Cartridge Controller for signing.

> **Read [ARCHITECTURE.md](./ARCHITECTURE.md) before contributing.** It captures every design decision and the rationale.

## Status

**Implemented.** The bot drives the full tournament lifecycle from inside Telegram:

- Auth (Cartridge session): `/connect`, `/disconnect`, `/whoami`
- Manage: `/create`, `/add_prize`
- Play: `/enter`, `/submit_score`
- Settle: `/claim` (auto or by reward kind), `/distribute`
- Browse: `/tournaments`, `/my_tournaments`, `/leaderboard`, `/prizes`, `/chain`

All on-chain encoding and reward resolution go through `@provable-games/budokan-sdk` — the example does not re-implement calldata.

The dependency-free read-only example at `examples/telegram-tournament-bot.mjs` remains the simpler reference.

> **Signing:** free `/enter` executes server-side via your Cartridge session. Paid `/enter` and `/add_prize` deeplink to budokan.gg to sign — Cartridge's keychain doesn't run reliably inside Telegram's in-app browser, so there's no in-Telegram per-tx flow.

## Layout

```
telegram-controller-bot/
├── ARCHITECTURE.md       Design doc — read first
├── README.md             This file
├── .env.example          Env vars
└── server/               Node + Fastify bot server
```

## Setup

Full local + production instructions — env vars, the `/connect` auth callback, and deployment — are in [DEPLOY.md](./DEPLOY.md). Quick start:

1. Get a `TELEGRAM_BOT_TOKEN` from `@BotFather`.
2. `bun install` in `server/`.
3. Set `BOT_PUBLIC_URL` to an HTTPS URL for the auth callback (`ngrok http 8787` is the easiest dev path).
4. `bun run dev` in `server/`.

See `.env.example` for all configuration.

## License

MIT
