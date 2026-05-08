# Telegram Controller Bot

A Telegram bot that lets users create, enter, and claim Budokan tournaments entirely from inside Telegram, using Cartridge Controller for signing.

> **Read [ARCHITECTURE.md](./ARCHITECTURE.md) before contributing.** It captures every design decision and the rationale.

## Status

**Scaffold stage.** Architecture and project structure are in place. Implementation lands stage by stage:

1. ✅ Architecture, scaffold
2. ⬜ Server foundation: HTTP + long-poll, auth handshake, `/connect` / `/disconnect` / `/whoami` end-to-end
3. ⬜ Mini App scaffold + connect mode
4. ⬜ Sessioned `/claim`, `/create`
5. ⬜ Per-tx Mini App mode + hybrid `/enter`
6. ⬜ Read-only commands ported from `examples/telegram-tournament-bot.mjs`

The dependency-free read-only example at `examples/telegram-tournament-bot.mjs` is unchanged and remains the simpler reference.

## Layout

```
telegram-controller-bot/
├── ARCHITECTURE.md       Design doc — read first
├── README.md             This file
├── .env.example          Env vars
├── server/               Node + Fastify bot server
└── miniapp/              Vite + React Telegram Mini App
```

## Setup (forthcoming)

The full local setup will involve:

1. Get a `TELEGRAM_BOT_TOKEN` from `@BotFather`.
2. Register the Mini App URL with `@BotFather` via `/newapp`.
3. Run `bun install` in both `server/` and `miniapp/`.
4. Set `BOT_PUBLIC_URL` to an HTTPS URL — `ngrok http 8787` is the easiest dev path.
5. Set `MINIAPP_URL` to the running Mini App (Vite dev server, or a deployed static site).
6. `bun run dev` in both directories.

Detailed instructions land with the working server (stage 2).

## License

MIT
