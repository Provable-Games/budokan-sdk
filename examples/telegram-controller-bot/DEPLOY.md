# Deploying to Railway

The bot is two services: a **server** (Bun + Fastify, public HTTPS) and a **Mini App** (static site). Both deploy from this repo via Dockerfiles.

## Why two services

The Mini App and the server have different build profiles, scaling shapes, and update cadences. Keeping them separate lets you redeploy the Mini App without bouncing the bot, and vice versa.

## The chicken-and-egg

Vite inlines `VITE_BOT_PUBLIC_URL` into the Mini App bundle **at build time**. The Mini App has no concept of "discover the bot URL at runtime". So the order matters:

1. Deploy the **server** first.
2. Generate its public Railway domain (e.g. `https://budokan-bot-server-production.up.railway.app`).
3. Set that URL as `VITE_BOT_PUBLIC_URL` on the Mini App service.
4. Deploy the **Mini App**.
5. Generate its public Railway domain.
6. Set that URL as `MINIAPP_URL` on the server service. The server picks it up immediately on the next restart (Railway auto-redeploys on variable change).

After this dance both services know each other's public URLs.

## Quick start (manual)

```bash
# Make sure railway CLI is logged in
railway login

# --- 1. Server ---
cd examples/telegram-controller-bot/server
railway link             # pick or create a project, name the service e.g. "telegram-bot-server"
railway up               # uploads + builds via Dockerfile

# Generate a domain
railway domain           # copies https://...up.railway.app

# Set env vars (replace placeholders)
railway variables --set TELEGRAM_BOT_TOKEN=123:abc
railway variables --set BUDOKAN_CHAIN=mainnet
railway variables --set BOT_PUBLIC_URL=https://<server-domain>.up.railway.app
railway variables --set MINIAPP_URL=https://<placeholder>          # see step 5 below
railway variables --set BOT_DATA_DIR=/data

# Mount a volume at /data for session storage (Railway dashboard → service → Volumes → New Volume → mount path /data)

# --- 2. Mini App ---
cd ../miniapp
railway link             # same project, new service e.g. "telegram-bot-miniapp"

# Set the build-time variable BEFORE deploying
railway variables --set VITE_BOT_PUBLIC_URL=https://<server-domain>.up.railway.app

railway up               # builds + deploys
railway domain           # generates the Mini App's domain

# --- 3. Close the loop ---
cd ../server
railway variables --set MINIAPP_URL=https://<miniapp-domain>.up.railway.app
# This triggers a redeploy of the server with the right MINIAPP_URL.
```

## Required env vars per service

### `telegram-bot-server`
| Var | Source | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather | secret |
| `BOT_PUBLIC_URL` | server domain | `https://<service>.up.railway.app` |
| `MINIAPP_URL` | mini-app domain | set after Mini App deploys |
| `BUDOKAN_CHAIN` | `mainnet` or `sepolia` | default mainnet |
| `BOT_DATA_DIR` | `/data` | mount a volume here |
| `PORT` | injected by Railway | don't set yourself |

### `telegram-bot-miniapp`
| Var | Source | Notes |
|---|---|---|
| `VITE_BOT_PUBLIC_URL` | server domain | **must be set before build** — Vite inlines it |
| `PORT` | injected by Railway | don't set yourself |

## Persistent storage

The bot stores per-chat session data in `BOT_DATA_DIR` (default `/data`). Without a Railway volume mounted there, every redeploy wipes everything and all users have to re-`/connect`.

Railway dashboard → server service → **Volumes** → New volume → mount path `/data`, size 1 GB is more than enough.

## Health checks

The server exposes `GET /healthz` returning `{ ok: true, chain }`. Configured in `server/railway.toml`. If your bot ever stops responding, Railway will recycle it.

## Logs

```bash
railway logs --service telegram-bot-server
railway logs --service telegram-bot-miniapp
```

Or via the dashboard.

## After deploy: BotFather wiring

In Telegram chat with `@BotFather`:
1. `/newapp` → choose your bot → name it → short description → upload an icon (512×512 PNG) → set the URL to your Mini App's Railway domain.
2. (Optional) `/setmenubutton` to add a persistent menu button that opens the Mini App.

Once registered, the `/connect` button in the bot will open the Mini App inside Telegram natively.

## Rotating the Telegram bot token

`@BotFather` → `/revoke` (gets a new token) → set `TELEGRAM_BOT_TOKEN` on the server → Railway auto-restarts.

## Cost shape

- Server: tiny — Bun process, mostly idle. Fits the Railway hobby tier comfortably.
- Mini App: serves static files. Cheaper.
- Volume: pay per GB-month; 1 GB is dollars per year.

Total runtime cost for a low-traffic bot is in the low single dollars per month.
