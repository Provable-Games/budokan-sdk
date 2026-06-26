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

## Local development against an unpublished SDK (no npm publish)

The bot depends on the published `@provable-games/budokan-sdk`, but while
iterating on SDK + bot together you don't need to publish a version each time —
link the local SDK with `bun link`:

```bash
# 1. From the repo root: build + register the local SDK once.
bun install
bun run dev            # watch-build the SDK (rebuilds dist on change)

# 2. In another shell, register + link it:
#    (root) bun link        # registers @provable-games/budokan-sdk
#    (server) bun link @provable-games/budokan-sdk
cd examples/telegram-controller-bot/server
bun link @provable-games/budokan-sdk

# 3. Run the bot against the local SDK (sepolia test bot token + ngrok URL):
bun run dev
```

Now SDK source changes are picked up live (the root `bun run dev` rebuilds
`dist/`; the bot's `--watch` reloads). `bun link` only changes `node_modules/`,
so `package.json` and the Railway deploy are untouched — Railway keeps using the
published version. **Publish a new SDK version only when a change is validated
and you want to deploy it** (then bump the bot's dependency). To unlink:
`bun unlink @provable-games/budokan-sdk` in `server/` and `bun install`.

## Local HTTPS tunnel (for /connect callback)

`/connect` redirects the Cartridge browser flow back to `BOT_PUBLIC_URL`, so it
must be a public HTTPS URL. For local dev, tunnel your bot's port (default 8787,
or whatever `HTTP listening on :<port>` prints):

```bash
# cloudflared — free, no signup, no interstitial (recommended).
# Grab the binary if it's not installed (works in a container, no root):
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared && chmod +x cloudflared
./cloudflared tunnel --url http://localhost:8787      # prints https://<random>.trycloudflare.com

# or, zero-install:
npx localtunnel --port 8787
```

Put the printed HTTPS URL in `BOT_PUBLIC_URL`, then start the bot. The tunnel
must run in the **same container/host** as the bot (so it can reach localhost),
and on free tiers the URL changes each restart — update `BOT_PUBLIC_URL` and
restart the bot when it does.
