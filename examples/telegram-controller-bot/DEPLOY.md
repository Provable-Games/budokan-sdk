# Deploying to Railway

The bot is a single **server** service (Bun + Fastify) with a public HTTPS URL. It deploys from this repo via the Dockerfile in `server/`.

The public URL is needed only for the Cartridge auth callback: when a user runs `/connect`, Cartridge redirects their browser to `BOT_PUBLIC_URL/api/connect/:token/callback` to hand the session back. Everything else is the Telegram long-poll loop, which needs no inbound URL.

## Quick start (manual)

```bash
# Make sure the railway CLI is logged in
railway login

cd examples/telegram-controller-bot/server
railway link             # pick or create a project, name the service e.g. "telegram-bot-server"
railway up               # uploads + builds via Dockerfile

# Generate a public domain
railway domain           # copies https://...up.railway.app

# Set env vars (replace placeholders)
railway variables --set TELEGRAM_BOT_TOKEN=123:abc
railway variables --set BUDOKAN_CHAIN=mainnet
railway variables --set BOT_PUBLIC_URL=https://<server-domain>.up.railway.app
railway variables --set BOT_DATA_DIR=/data

# Mount a volume at /data for session storage
# (Railway dashboard → service → Volumes → New Volume → mount path /data)
```

## Required env vars

| Var | Source | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather | secret |
| `BOT_PUBLIC_URL` | server domain | `https://<service>.up.railway.app` — used for the Cartridge auth callback |
| `BUDOKAN_CHAIN` | `mainnet` or `sepolia` | default mainnet |
| `BOT_DATA_DIR` | `/data` | mount a volume here |
| `PORT` | injected by Railway | don't set yourself |

See `.env.example` for the optional vars (SDK endpoint overrides, the Voyager proxy for the `/create` prize picker).

## Persistent storage

The bot stores per-chat session data in `BOT_DATA_DIR` (default `/data`). Without a Railway volume mounted there, every redeploy wipes everything and all users have to re-`/connect`.

Railway dashboard → service → **Volumes** → New volume → mount path `/data` (1 GB is plenty).

## Health checks

The server exposes `GET /healthz` returning `{ ok: true, chain }`. Configured in `server/railway.toml`. If the bot stops responding, Railway recycles it.

## Logs

```bash
railway logs --service telegram-bot-server
```

Or via the dashboard.

## Rotating the Telegram bot token

`@BotFather` → `/revoke` (gets a new token) → set `TELEGRAM_BOT_TOKEN` on the server → Railway auto-restarts.

## Cost shape

Tiny — a mostly-idle Bun process plus a small volume. A low-traffic bot runs in the low single dollars per month on Railway's hobby tier.
