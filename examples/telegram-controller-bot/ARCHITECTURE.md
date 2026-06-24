# Telegram Controller Bot — Architecture

This document captures the design decisions for the Telegram bot that talks to Budokan via Cartridge Controller. **Read this before reviewing code.** It records every decision and its rationale so we can argue with the design before implementation deepens.

> **Update — the per-tx Mini App was removed.** Auth now uses only the Cartridge slot-pattern callback (a regular browser redirect, not an in-Telegram `web_app`). Free actions execute via the persisted session; paid `/enter` and `/add_prize` deeplink to budokan.gg to sign. The `miniapp/` tree and `/api/tx/*` routes no longer exist. Sections below describing the Mini App / per-tx handshake are retained as historical design rationale.

## Goals

1. Users perform Budokan actions (create / enter / claim) entirely from inside Telegram — no jumping to `budokan.gg`.
2. Free actions (`/create`, `/claim`) execute via a **persistent session** authorized once by the user.
3. Paid actions (`/enter` for tournaments with an entry fee) require **per-tx approval** — no risk of the bot draining funds.
4. The user's master key never leaves their device. Cartridge Controller manages keys via passkey / Google / Discord / etc.

## Non-goals

- Custodial wallet behaviour. The bot never holds user master keys.
- Browser-based fallback. We're committed to in-Telegram signing.
- Replacing the existing read-only `examples/telegram-tournament-bot.mjs` — it stays as the dependency-free reference.

## High-level architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Telegram app (user's phone)                                   │
│                                                                │
│  Chat with @BudokanBot ◄────────► Mini App webview             │
│         │                                  │                   │
│         │ Telegram Bot API                 │ HTTPS             │
│         ▼                                  ▼                   │
└─────────┼──────────────────────────────────┼───────────────────┘
          ▼                                  ▼
   ┌──────────────────┐            ┌────────────────────┐
   │  Bot server      │            │  Mini App          │
   │  (Node + Fastify)│            │  (Vite + React)    │
   │  - long-poll     │◄──────────►│  - Cartridge SDK   │
   │  - HTTP API      │  /api/...  │  - sessions        │
   │  - session store │            │  - per-tx signing  │
   │  - calls Budokan │            │                    │
   └──────────────────┘            └────────────────────┘
            │
            ▼
     Starknet (Budokan contract)
```

Two deployable artifacts:

- **Bot server**: Node.js process. Holds Telegram bot token, listens for Telegram messages via long-poll, exposes a small HTTP API the Mini App talks to. Stores per-chat session keys on the filesystem (or a durable store later).
- **Mini App**: static SPA. Hosted anywhere with HTTPS. Loads `@cartridge/controller`, runs Cartridge auth in-Telegram, posts session data back to the bot server.

## Hybrid auth model

Two distinct flows, both using Cartridge Controller in the Mini App:

### Flow 1 — Onboarding (sessioned)

User runs `/connect`. Bot generates a one-time UUID `connect_token`, returns a Telegram `web_app` button pointing at `${MINIAPP_URL}/?token=<uuid>&mode=connect`. User taps the button; Mini App opens inside Telegram.

In the Mini App:
1. Fetch the policy bundle from the bot: `GET ${BOT_PUBLIC_URL}/api/connect/<token>` — returns chain, policies for `create_tournament` / `claim_reward` / `submit_score`, and **no `approve` policies** (paid entries are handled per-tx).
2. Initialize `ControllerProvider` with those policies.
3. User signs in (passkey / google / etc.) and approves the policy list.
4. Mini App POSTs the resulting session bundle to `POST ${BOT_PUBLIC_URL}/api/connect/<token>` — `{ address, username, sessionData }`.
5. Bot persists session keys keyed by `chatId` (looked up from token), pushes a confirmation message to the chat.
6. Mini App calls `WebApp.close()` to dismiss itself.

### Flow 2 — Paid action (per-tx)

User runs `/enter <id>` and the tournament has an entry fee. Bot generates a one-time `tx_token`, computes the calls (`approve(token, fee, Budokan)` + `enter_tournament(id)`), returns a `web_app` button to `${MINIAPP_URL}/?token=<uuid>&mode=tx`.

In the Mini App:
1. Fetch the tx bundle from the bot: `GET ${BOT_PUBLIC_URL}/api/tx/<token>` — returns `{ chain, calls, summary }`.
2. Initialize `ControllerProvider` with **no policies** (or the bare minimum) so each call requires explicit user confirmation.
3. Render the call summary, ask the user to confirm.
4. `controller.execute(calls)` — Cartridge prompts the user to sign in if not already, then signs the multicall.
5. POST `{ txHash }` to `POST ${BOT_PUBLIC_URL}/api/tx/<token>`.
6. Bot polls the tx for inclusion, posts result to chat.
7. Mini App closes.

`/claim` and `/create` always go through Flow 1's session — no Mini App round-trip per call.

## Component layout

```
examples/telegram-controller-bot/
├── ARCHITECTURE.md                  This file
├── README.md                        Setup, dev, deploy
├── .env.example                     All env vars in one place
├── .gitignore
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                 Entrypoint: starts HTTP + long-poll
│   │   ├── config.ts                Env var loading + validation
│   │   ├── http.ts                  Fastify server, routes
│   │   ├── telegram.ts              Long-poll loop, command dispatcher
│   │   ├── handshake.ts             Token mint + claim, in-memory TTL store
│   │   ├── session-store.ts         Per-chat filesystem persistence
│   │   ├── controller-account.ts    Build a starknet.js Account from session
│   │   ├── policies.ts              Static policy bundle (Budokan methods, no approvals)
│   │   ├── budokan.ts               Bot-side wrappers: getTournament, buildEnterCalls, ...
│   │   ├── commands/                One file per command group
│   │   │   ├── connect.ts           /connect, /disconnect, /whoami
│   │   │   ├── readonly.ts          /follow, /tournaments, /leaderboard, /prizes (ported from .mjs)
│   │   │   ├── claim.ts             /claim
│   │   │   ├── create.ts            /create (multi-turn Q&A state machine)
│   │   │   └── enter.ts             /enter (free → session, paid → tx Mini App)
│   │   └── util/
│   │       ├── telegram-api.ts      Raw fetch wrapper, sendMessage with chunking
│   │       └── format.ts            formatErc20, KNOWN_TOKENS, prize expansion
│   └── data/                        Filesystem persistence (gitignored)
│       ├── sessions/<chatId>/session.json
│       └── follows.json             Read-only follows from existing example
└── miniapp/
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx                  Route by ?mode=connect|tx
        ├── api.ts                   Talks to bot server
        ├── controller.ts            Cartridge SDK setup (browser mode)
        ├── modes/
        │   ├── Connect.tsx          Onboarding flow
        │   └── Tx.tsx               Per-tx confirmation flow
        └── components/              Buttons, errors, status
```

## Auth handshake protocol

The bot is the source of truth. All tokens are minted server-side, single-use, 5-minute TTL. The Mini App is dumb — it forwards user actions to the bot.

### Connect handshake

```
User → Bot:        /connect
Bot:               mints connect_token (UUID), stores { chatId, mode: "connect", expiresAt }
Bot → User:        web_app button → MINIAPP_URL/?token=<uuid>&mode=connect
User taps button → Mini App opens

Mini App → Bot:    GET /api/connect/<token>
Bot →:             { chain, policies, status: "pending" }   (returns 404 if token invalid/used/expired)

Mini App:          ControllerProvider.connect({ policies })
                   user does Cartridge passkey/google flow + approves policies
                   gets { address, username, sessionData }

Mini App → Bot:    POST /api/connect/<token>
                   body: { address, username, sessionData }
Bot:               validates token still in-flight, persists to data/sessions/<chatId>/session.json
                   marks token as consumed
Bot → :            { ok: true }

Mini App:          WebApp.close()

Bot → User:        message "Connected as <username>. /enter, /create, /claim are now active."
```

### Tx handshake

```
User → Bot:        /enter 42
Bot:               getTournament(42), reads entryFee
                   if no fee → fall through to session path (skip Mini App)
                   else: builds calls = [ approve(token, fee, Budokan), enter_tournament(42) ]
                   mints tx_token, stores { chatId, mode: "tx", calls, summary, expiresAt }
Bot → User:        web_app button → MINIAPP_URL/?token=<uuid>&mode=tx

Mini App → Bot:    GET /api/tx/<token>
Bot →:             { chain, calls, summary }

Mini App:          ControllerProvider.connect()  (no session, fresh sign)
                   render summary, "Confirm" button
                   on tap: controller.execute(calls)
                   gets { txHash }

Mini App → Bot:    POST /api/tx/<token>  body: { txHash }
Bot:               polls Starknet for tx inclusion, replies in chat

Mini App:          WebApp.close()
```

### Notes on the protocol

- Tokens are **server-minted, server-validated**. The Mini App can't fabricate a session.
- Tokens carry `chatId` server-side only. The URL exposes only the opaque token. A leaked URL lets an attacker complete a session for someone else's chat — but only within the 5-minute window, and only once.
- Session POST validates the `address` claim against the Cartridge backend (TODO: figure out how to verify the session is real and not forged client-side; likely involves checking on-chain via the session's address signing scheme). For v1 we trust the Mini App and harden later.
- Tx tokens are bound to specific calldata: even a leaked URL only authorizes the exact `enter_tournament(42)` action, not an arbitrary call.

## Session storage

Filesystem-based for v1. `data/sessions/<chatId>/session.json` holds:

```json
{
  "address": "0x...",
  "username": "alice",
  "ownerGuid": "0x...",
  "privKey": "0x...",        // session private key the bot signs with
  "pubKey": "0x...",
  "expiresAt": "1234567890",
  "guardianKeyGuid": "0x0",
  "metadataHash": "0x0",
  "sessionKeyGuid": "0x..."
}
```

This mirrors the shape `controller/packages/controller/src/node/backend.ts` writes — we'll use that backend as a starting point but namespace per chatId.

For prod, swap to Postgres / Redis. Schema is small.

## Build and submit (server-side execution)

For sessioned actions the bot constructs a `starknet.js` `Account` from the session's `privKey` and `address`, then `account.execute(calls)`. Cartridge's session signing scheme requires a few extra params (`ownerGuid`, `sessionKeyGuid`, etc.) — `controller/packages/controller/src/node/account.ts` already does this. We import / reuse.

## Read-only commands

`/follow`, `/tournaments`, `/leaderboard`, `/prizes`, `/tournament`, `/following`, `/chain` are ported from `examples/telegram-tournament-bot.mjs` into TS modules under `server/src/commands/readonly.ts`. Same logic, same WebSocket subscription via budokan-sdk. Lives in the new project so users have one bot to deploy, not two.

## Mini App framework

**Vite + React + TypeScript.** Reasons:
- `@cartridge/controller` is React-friendly; the Cartridge team maintains React example apps.
- The user's existing client (`/workspace/budokan/client`) is React+Vite; familiar territory.
- Tiny bundle footprint when tree-shaken.
- Static output deploys to any host.

The Mini App talks to Telegram's WebApp JS API (`window.Telegram.WebApp`) for theme detection, expanded-mode, close, sendData, etc. Standard pattern.

## Configuration

All via env vars; `.env.example` documents them.

| Var | Required | Default | Used by | Notes |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | server | from BotFather |
| `BUDOKAN_CHAIN` | no | `mainnet` | server | `mainnet` or `sepolia` |
| `BOT_PUBLIC_URL` | yes | — | server, miniapp | bot's public HTTPS URL — Mini App POSTs here |
| `MINIAPP_URL` | yes | — | server | Mini App's public URL — bot embeds in `web_app` button |
| `BOT_HTTP_PORT` | no | `8787` | server | local listen port (proxied by ngrok / reverse proxy) |
| `BOT_DATA_DIR` | no | `./data` | server | filesystem session storage root |
| `BUDOKAN_API_URL` | no | from chain preset | server | optional override |
| `BUDOKAN_RPC_URL` | no | from chain preset | server | optional override |

`BOT_PUBLIC_URL` and `MINIAPP_URL` may be different domains. In dev: `BOT_PUBLIC_URL=https://<your-ngrok>.ngrok.io`, `MINIAPP_URL=http://localhost:5173` (Telegram Mini Apps allow http on localhost during dev). In prod: both deployed.

## What this doesn't solve

- **Bot horizontal scaling**: filesystem sessions tie a bot instance to its data directory. Two replicas need a shared store. Out of scope for v1.
- **Mini App offline / cached**: the Mini App makes live HTTP calls to the bot. If the bot is down, the Mini App fails gracefully; it does not retry indefinitely.
- **Session refresh / re-auth UX**: when a session expires, sessioned commands fail. v1 surfaces "session expired, run /connect again" — no automatic refresh.
- **Multiple chains per user simultaneously**: a chat is on exactly one chain at a time (current `/chain` semantics). Sessions are chain-scoped.
- **Group chats**: v1 is private-chat focused. Group chat semantics (whose session does the bot use?) are deferred — a session in a group probably belongs to whoever ran `/connect` first, but that's a v2 conversation.

## Sequencing (build order)

1. Project skeleton (this turn): directories, package.jsons, tsconfigs, this doc, READMEs, env example.
2. Server foundation: Fastify + long-poll co-existing, in-memory token store, session POST receiver, per-chat filesystem storage. `/connect`, `/disconnect`, `/whoami` end-to-end.
3. Mini App scaffold: Vite + React + Cartridge SDK. Connect mode flow.
4. Sessioned commands: `/claim`, `/create` (multi-turn).
5. Per-tx Mini App mode + `/enter` hybrid.
6. Read-only commands ported from the existing `.mjs`.
7. README setup guide for ngrok + BotFather.

After step 2, you'll be able to verify auth round-trip works end-to-end before any transactions are signed. That's the de-risk milestone.
