# Telegram Tournament Bot

This example runs a dependency-free Telegram bot that lets a chat follow one or more Budokan tournaments and receive live updates as registrations, scores, prizes, and reward claims land.

It uses Telegram long polling (`getUpdates`), so it does not need a public HTTPS webhook. On startup it calls `deleteWebhook` because `getUpdates` can return a conflict when a webhook is configured.

The Budokan SDK is read-only — the bot displays data and pushes notifications. Actions that require signing (entering a tournament, submitting a score, claiming a prize) are surfaced as deeplinks back to the Budokan web app, where the user signs with their Cartridge wallet.

## Create a Telegram bot

1. Open Telegram and message `@BotFather`.
2. Send `/newbot`.
3. Choose a display name and username.
4. Copy the bot token from BotFather.

Keep the token secret.

## Run locally

From the repo root:

```bash
bun install
bun run build
export TELEGRAM_BOT_TOKEN="123456789:replace-with-your-token"
node examples/telegram-tournament-bot.mjs
```

The script starts the bot and stores follows in `.telegram-tournament-bot-registrations.json` by default.

Optional environment variables are listed in `telegram-tournament-bot.env.example`. Empty optional environment variables are ignored, so unset and empty values both use the SDK defaults.

## Test in Telegram

Open a private chat with your bot and send:

```text
/start
/follow 42
/tournament 42
/leaderboard 42
```

Expected results:

- `/start` returns the command list.
- `/follow` confirms the tournament follow.
- `/tournament` returns the tournament's name, phase windows, entry/submission counts, and entry fee.
- `/leaderboard` returns the top 20 leaderboard positions.
- Live `tournaments`, `registrations`, `prizes`, and `rewards` WebSocket events for any followed tournament are posted into the chat.

To stop updates:

```text
/unfollow 42
```

You can also add the bot to a group and run `/follow 42` in that group. If BotFather privacy mode is enabled, use `/follow@your_bot_username 42` or disable privacy mode with `/setprivacy` in BotFather.

## Available commands

| Command | Description |
|---------|-------------|
| `/start`, `/help` | Show command list |
| `/follow <id>` | Subscribe this chat to live updates for a tournament |
| `/unfollow <id>` | Stop following one tournament |
| `/unfollow` | Stop following all tournaments in this chat |
| `/following` | List followed tournaments |
| `/tournament <id>` | Show tournament details |
| `/leaderboard <id>` | Show top 20 leaderboard entries |
| `/prizes <id>` | List posted prizes |
| `/tournaments [phase]` | List recent tournaments, optionally filtered by phase (`scheduled`, `registration`, `staging`, `live`, `submission`, `finalized`) |
| `/play <id>` | Show options to enter or play: in Telegram (via the play bot) or in browser |
| `/claim <id>` | Show options to claim rewards: in Telegram (via the play bot) or in browser |

## Why deeplinks for actions?

Budokan tournament actions (entering, submitting a score, claiming a prize) require Starknet transactions signed by the player's wallet. The browser app uses [Cartridge Controller](https://docs.cartridge.gg/controller) to manage keys; a read-only Telegram bot does not have access to that wallet. `/play` and `/claim` therefore return a URL to `https://budokan.gg/tournament/<id>` so the user can complete the action in their browser session.

This bot stays read-only on purpose, which makes it safe to run in a **public channel** — it holds no keys and signs nothing. See the architecture note below for why signing belongs in a private chat.

## Optional: hand off to the in-Telegram play bot

The companion [`telegram-controller-bot`](./telegram-controller-bot) signs Budokan actions inside Telegram using a scoped, spend-capped [Cartridge Controller](https://docs.cartridge.gg/controller) session that the user authorizes once. Because it holds session keys and keys everything off the chat id, it is **DM-only** — do not put it in a public channel.

Set `PLAY_BOT_USERNAME` to that bot's username (without `@`) to bridge the two. `/play` and `/claim` then present two options:

- **In Telegram (recommended)** — a `https://t.me/<PLAY_BOT_USERNAME>?start=<action>_<id>_<chain>` deep link. Tapping it opens a private chat with the play bot and resumes the flow there (the play bot's `/start` handler parses the payload). The user runs `/connect` once, then enters/claims in chat — no browser.
- **In your browser** — the `https://budokan.gg/tournament/<id>` link, which works with no extra setup.

When `PLAY_BOT_USERNAME` is unset, `/play` and `/claim` return only the browser link, so this bot is fully useful deployed on its own. This split — public read-only bot for discovery, DM controller bot for signing — is the recommended Telegram deployment.

If you need server-side signing for an automated workflow (for example, an admin script that distributes refunds), use `starknet.js` with a dedicated account directly — outside this bot.

## Command menu

The bot registers its `/` autocomplete menu automatically on startup via
`setMyCommands`, so the commands (and the play/claim wording, which adapts to
whether `PLAY_BOT_USERNAME` is set) appear in Telegram with no manual step.

If you ever want to set it by hand — for example from a deploy script — the
equivalent call is:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command":"help","description":"Show command list"},
      {"command":"tournaments","description":"List recent tournaments"},
      {"command":"tournament","description":"Show tournament details"},
      {"command":"leaderboard","description":"Show the top 20 leaderboard"},
      {"command":"prizes","description":"List posted prizes"},
      {"command":"play","description":"Enter or play (in Telegram or browser)"},
      {"command":"claim","description":"Claim rewards (in Telegram or browser)"},
      {"command":"follow","description":"Get live updates for a tournament"},
      {"command":"unfollow","description":"Stop following a tournament"},
      {"command":"following","description":"List followed tournaments"},
      {"command":"chain","description":"Show or switch the active chain"}
    ]
  }'
```

## Deploy with systemd

Example VPS deployment:

```bash
sudo git clone https://github.com/Provable-Games/budokan-sdk.git /opt/budokan-sdk
sudo chown -R "$USER":"$USER" /opt/budokan-sdk
cd /opt/budokan-sdk
bun install
bun run build
```

Create an environment file:

```bash
sudo tee /etc/budokan-telegram-bot.env >/dev/null <<'EOF'
TELEGRAM_BOT_TOKEN=123456789:replace-with-your-token
BUDOKAN_CHAIN=mainnet
REGISTRATIONS_FILE=/opt/budokan-sdk/.telegram-tournament-bot-registrations.json
EOF
sudo chown root:root /etc/budokan-telegram-bot.env
sudo chmod 600 /etc/budokan-telegram-bot.env
```

Create the service:

```bash
sudo tee /etc/systemd/system/budokan-telegram-bot.service >/dev/null <<'EOF'
[Unit]
Description=Budokan Telegram Tournament Bot
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/budokan-sdk
EnvironmentFile=/etc/budokan-telegram-bot.env
ExecStart=/usr/bin/node examples/telegram-tournament-bot.mjs
Restart=always
RestartSec=5
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF
```

Start and inspect logs:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now budokan-telegram-bot
sudo journalctl -u budokan-telegram-bot -f
```

Replace `User=ubuntu` with the operating-system user that owns `/opt/budokan-sdk`.
