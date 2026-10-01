# Deploying to Railway

The bot is a single **server** service (Node 22 + Fastify; Bun builds dependencies) with a public HTTPS URL. It deploys from this repo via the Dockerfile in `server/`.

The public URL is needed only for the Cartridge auth callback: when a user runs `/connect`, Cartridge redirects their browser to `BOT_PUBLIC_URL/api/connect/:token/callback` to hand the session back. Everything else is the Telegram long-poll loop, which needs no inbound URL.

## Quick start (manual)

```bash
# Make sure the railway CLI is logged in
railway login

# Run from the repository root, not server/.
railway link             # pick or create a project, name the service e.g. "telegram-bot-server"
# In service settings: Root Directory = /, Config File =
# /examples/telegram-controller-bot/server/railway.toml
railway up               # uploads the root SDK and bot together

# Generate a public domain
railway domain           # copies https://...up.railway.app

# Set env vars (replace placeholders)
railway variables --set TELEGRAM_BOT_TOKEN=123:abc
railway variables --set BUDOKAN_CHAIN=mainnet
# Use all three values from the same new GameCore-compatible deployment.
railway variables --set "BUDOKAN_ADDRESS=<new-contract-address>"
railway variables --set "BUDOKAN_VIEWER_ADDRESS=<new-viewer-address>"
railway variables --set "BUDOKAN_API_URL=<new-api-url>"
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
| `BUDOKAN_ADDRESS` | new deployment | Required; legacy contract addresses cannot accept SDK 0.4.0 writes |
| `BUDOKAN_VIEWER_ADDRESS` | new deployment | Required; must match the Budokan contract |
| `BUDOKAN_API_URL` | new deployment | Required; must index the same Budokan contract |
| `BOT_DATA_DIR` | `/data` | mount a volume here |
| `PORT` | injected by Railway | don't set yourself |

See `.env.example` for the optional vars (SDK endpoint overrides, the Voyager proxy for the `/create` prize picker).

Startup fails before connecting to Telegram if any deployment setting is missing.
These overrides apply to this bot instance; configure all three for `BUDOKAN_CHAIN`.

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

Tiny — a mostly-idle Node process plus a small volume. A low-traffic bot runs in the low single dollars per month on Railway's hobby tier.

## Local development against an unpublished SDK (no npm publish)

The server uses `file:../../..` to load this SDK checkout. Build the root first:

```bash
bun install --frozen-lockfile
bun run build
cd examples/telegram-controller-bot/server
bun install --frozen-lockfile
bun run dev
```

Rebuild the SDK and reinstall the example after changing SDK source. The Docker
build performs these same steps and preserves the relative package path at runtime.
To build the image locally, run from the repository root:

```bash
docker build -f examples/telegram-controller-bot/server/Dockerfile -t budokan-bot .
```

After migrating to SDK 0.4.0 and the new Budokan deployment, existing users must
run `/connect` again to authorize `enter_tournament_for_recipients`. Session
resolution already rejects policies that omit newly required methods; it does
not widen an existing user's authorization automatically.

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
