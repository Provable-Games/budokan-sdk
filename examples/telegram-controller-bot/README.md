# Telegram Controller Bot

A Telegram bot that lets users create, enter, and claim Budokan tournaments entirely from inside Telegram, using Cartridge Controller for signing.

> **Read [ARCHITECTURE.md](./ARCHITECTURE.md) before contributing.** It captures every design decision and the rationale.

## Status

**Implemented.** The bot drives the full tournament lifecycle from inside Telegram:

- Auth (Cartridge session): `/connect`, `/disconnect`, `/whoami`, `/wallet`
- Manage: `/create`, `/add_prize`
- Play: `/enter`, `/submit_score`
- Settle: `/claim` (auto or by reward kind), `/distribute`
- Browse: `/tournaments`, `/my_tournaments`, `/leaderboard`, `/chain`
- Broadcast: `/follow`, `/unfollow`, `/following`

All on-chain encoding and reward resolution go through `@provable-games/budokan-sdk` — the example does not re-implement calldata.

> **Channel broadcasts:** run `/channel` in a group/channel to make it the announce target. Tournaments created via `/create` are auto-followed; add others with `/follow <id>`. A 60s poller posts a card on each **time-driven** lifecycle edge — **entry open → live → games over (submit scores) → finalized** — derived from the tournament's boundary timestamps (nothing on-chain fires for them). At finalize it also posts a **winner card** (top finishers within the prize spots, with amounts won). **Event-driven** updates — score submissions and prize additions — stream low-latency over the SDK `submissions` / `prizes` WebSocket channels (debounced into one aggregated card per burst) when the runtime has a global WebSocket (Node ≥ 22 / Bun); otherwise they fall back to the poller's count-diff. After finalize the watch is kept to drain reward claims, posting **"all rewards distributed"** once everything is claimed (or dropping after a 14-day cap). A card send that Telegram rejects as a dead chat (bot kicked / chat gone) drops that watch.

The dependency-free read-only example at `examples/telegram-tournament-bot.mjs` remains the simpler reference.

> **Signing:** `/connect` authorizes a Cartridge session with per-token **spending limits** for the common tokens (ETH, STRK, USDC, …). With those, **paid `/enter` and `/add_prize` run entirely in Telegram** — the bot approves the exact amount and signs in one multicall, no browser round-trip. Amounts above your limit, unrecognized tokens, NFT prizes, and distributed-payout prizes fall back to a budokan.gg deeplink. Limits are per-token caps you see and approve in the keychain (tune them in `server/src/catalog/tokens.ts`).

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
