# Budokan bots — what's built, paid brackets, and the session models

A reference for the Budokan Telegram bots: the system as it stands today, the
proposed paid-bracket (entry-fee) design, and a breakdown of the **DM session
model** (today) vs the **user-scoped session model** (for public channels and
the Discord port).

---

## 1. What we've built

### Two-bot architecture

- **Public read-only bot** (`examples/telegram-tournament-bot.mjs`,
  `@budokan_public_bot`). Holds no keys, signs nothing — safe in a public
  group. Discovery + live notifications: `/tournaments`, `/leaderboard`,
  `/prizes`, `/follow` (WebSocket updates), and `/play` / `/claim` / `/connect`
  / `/create` which **hand off** to the signer bot via deep links
  (`https://t.me/<PLAY_BOT_USERNAME>?start=…`) or to budokan.gg.
- **DM signer bot** (`examples/telegram-controller-bot`, `@budokan_tg_bot`).
  Holds scoped, spend-capped Cartridge sessions and signs on the user's behalf.
  **DM-only** (see §3).

### SDK (`@provable-games/budokan-sdk`, current `0.1.30`)

- `getSubmittableScores` / `buildSubmitScoreCalls` — submit_score positions the
  way the web client computes them.
- **Qualified entry** — `buildEnterTournamentCall({ qualification })` +
  `buildTournamentQualificationProof` (enter an entry-gated tournament on a
  player's behalf).
- **Gated 1v1 brackets** (`src/brackets`) — seeded single-elim tree, the
  **upfront gated-deploy** layer (`roundMatchCreateCalls`, `bracketFeeders`,
  `bracketFinalPrizeCalls`, `bracketEntryCalls`, `bracketRounds`,
  `bracketSummary`), plus `createBracket`/`advanceBracket`. One match = one
  2-player tournament; round >1 entry is gated on having won the feeder match.

### Signer bot commands

- **Auth**: `/connect` (Cartridge session via browser redirect), `/disconnect`,
  `/whoami`, `/chain`.
- **Play**: `/enter` (picker + inline Enter buttons; paid entries via session
  spending limit), `/submit_score` (picker; submit `mine` or `all`), `/claim`
  (prize overview → claim `mine` or pay out `all`), `/distribute`, `/create`,
  `/add_prize`.
- **Brackets**: `/bracket` (create — **closed** / **open** / **mix**), players
  by **0x address or Cartridge username** (resolved via
  `api.cartridge.gg/lookup`); `/bracket_join`, `/bracket_start`, `/brackets`,
  `/bracket_view`. Open/mix post a **live registration card with a Join button**
  to the public channel; the whole gated tree deploys upfront, the bot enters
  round 1 + winners on their behalf, and a 60s poller advances rounds and posts
  updates. Optional **sponsored champion prize** on the final.

The fix that made signing work: `@cartridge/controller` ≥ 0.13 (policy-address
normalization) — see `cartridge-session-not-registered` in memory.

---

## 2. Proposed: paid brackets (entry fee → placement pool)

**Goal:** pay to enter, the pool grows with entrants, and the top placements get
paid by a configurable split — all **non-custodial**.

**Constraint:** Budokan entry fees are *per-tournament* and stay locked in the
tournament that collected them, paying *that* tournament's leaderboard. A
bracket is many tournaments, and bracket placement isn't a game score — so you
cannot natively **move** round-1 fees into a single "final pool", nor pay out by
bracket placement, without custody.

**Design (non-custodial, same UX):** *joining escrows the fee directly as
placement prizes on the already-deployed bracket matches.*

- Champion + runner-up → a distributed ERC20 prize on the **final** (positions
  1 & 2).
- 3rd/4th → a prize on each **semifinal** (the loser's slot, position 2).
- 5th–8th → a prize on each **quarterfinal**, etc. (one round = one placement
  tier; deeper tiers = earlier rounds' losers).

Each join adds its share to those prizes, so the pool grows per entrant exactly
like a buy-in. Funds escrow in the match contracts (never the bot). Placements
claim via the existing `/claim`. The tier split is **fully configurable**,
mirroring the tournament entry-fee distribution.

**Mechanics to implement:**
1. Bracket gains `entryFee { token, amount }` + a placement split config.
2. Joining pays the fee from the **player's own session** (approve + add_prize),
   using the same spending-limit policy as paid `/enter`.
3. Per join, build add_prize calls splitting the fee across the tier slots
   (final / semis / …) per the config.
4. Card shows entry fee, current pool, and the tier breakdown (like the mock).

**Alternative (rejected): custodial pool** — bot collects fees and redistributes.
Matches the mock literally but breaks the non-custodial guarantee.

---

## 3. Session models: DM (today) vs user-scoped (public / Discord)

This is the crux for opening brackets to public channels and for the Discord
port.

### How sessions are stored today

A Cartridge session (scoped to Budokan methods, spend-capped) is persisted by
the bot, **keyed by `chatId`**. In a Telegram **DM, `chat.id` == the user's id**
— so on disk, **sessions are already per-user**. The DM-only limitation is not
about storage; it's about *how commands resolve which session to use*.

### DM session model (current)

- **Resolution key:** `message.chat.id`. Correct in a DM (1:1). In a **group**,
  `chat.id` is the *room*, shared by everyone — so a group would collapse to one
  shared session. That's why the signer bot is **DM-only**.
- **Reply surface:** the DM. Telegram has **no ephemeral (private-in-public)
  messages**, so anything sensitive must happen in a DM.
- **Public channels:** handled by the *read-only* bot (discovery) + handoff
  links into the DM signer.

### User-scoped session model (public channels / Discord)

- **Resolution key:** the **user's id** (`from.id` on Telegram,
  `interaction.user.id` on Discord) — delivered by the platform, not spoofable.
  Because it's independent of the chat, the bot can serve **many users in one
  public channel**, each acting on *their own* session.
- We already use this for the bracket **Join button**: a tap in a group yields
  `from.id`, which **equals that user's DM `chat.id`**, so we resolve their
  existing (DM-stored) session from a public button. The storage is already
  user-keyed; only the *resolution* changed.

### The Telegram opening (incremental)

Because sessions are already stored per-user, the Telegram signer *could* accept
commands in a public group by resolving sessions via `from.id` instead of
`chat.id` — never using `chat.id` for session lookup in groups. The blocker is
**confidentiality**: Telegram can't reply privately in a group, so sensitive
output (errors, balances, confirmations) would leak. Practical pattern: trigger
in-group via `from.id`, **reply in the user's DM** (the bot can DM anyone who
has started it), and keep `/connect` in DM (Mini App buttons only work in DMs).

### Why Discord is the natural fit

Discord has **ephemeral interaction responses** (`flags: Ephemeral`) — replies
visible only to the invoking user, *in the public channel*. So the whole flow
(connect, enter, claim, bracket join) can be private-in-public with no DM bounce.

| Aspect | DM model (Telegram) | User-scoped (Discord) |
|---|---|---|
| Session key | `chat.id` (DM == user) | `interaction.user.id` |
| Signing surface | DM only | in-channel (ephemeral) |
| Private reply in public | ✗ (bounce to DM) | ✓ ephemeral |
| Connect flow | DM Mini App / redirect | ephemeral button → browser → callback |
| Public-channel use | read-only + handoff | full per-user, in place |
| Storage | per-user (by DM chat id) | per-user (by `discord:<id>`) |

### Discord port — shape

- Reuse the **session backend** unchanged (scoped, spend-capped, keyed by a
  platform-prefixed user id, e.g. `discord:<id>`), and the **SDK** (calldata,
  brackets, claim/submit helpers) as-is.
- New thin **adapter**: slash commands + ephemeral responses; `/connect` via an
  ephemeral button → browser → callback storing the session under the Discord
  user id; everything else (`/enter`, `/claim`, `/submit`, bracket create/join)
  ephemeral and in-channel.
- Brackets gain a true public experience: the registration card + Join button
  live in the channel, and each interaction is private to the tapping user — no
  DM round-trip.

## Entry integrity (on-chain limits — important caveat)

Budokan does **not** enforce one entry per address on-chain. `enter_tournament`
has no per-caller dedup — each call mints a fresh tournament token. The built-in
`entry_limit` field is counted **per qualifier** (an NFT token id / qualification
proof hash), **never per caller address**, and only applies when a tournament
has an entry requirement. There are exactly two built-in requirement types
(`token` NFT-gate, `extension`); neither is keyed by address. So:

- **Round-1 matches are open (no requirement)** → there is no on-chain
  per-address cap available. `entry_limit` cannot express "open to anyone but 1
  per address" — that needs a **custom `IEntryRequirementExtension`** contract.
- **Gated rounds** use the production `tournament_validator` extension, whose
  `valid_entry` checks only token ownership + leaderboard position; the framework
  `entry_limit` is a no-op for extension gates and this preset keeps no enforced
  counter. So a winner's qualifier token can technically be reused (double-enter
  a gated round). The configured limit is surfaced only by an advisory
  `entries_left` view that the entry path never calls.

**How the bot stays correct anyway (the chosen model):**

- The **bot is the entry path.** `paidJoin`/`join` enforce **one entry per
  address per bracket** (membership check before assigning a slot), and the bot
  is the only thing that enters players in normal use.
- **Resolution is competitor-keyed.** `resolveWinner` looks up only the match's
  two named `playerA`/`playerB` by address and compares *their* leaderboard
  positions — so a random third entrant **cannot "win"** a match, and a winner
  double-entering their own next match is harmless (the duplicate token is
  ignored). This holds regardless of on-chain entry caps.

**Residual gap (accepted):** a griefer who *plays* a round-1 match they're not
part of and scores #1 can push the real winner to position 2, which can block
that winner's position-based qualification into the **gated** next round. This
requires bypassing the bot on-chain *and* outscoring both real players, and only
affects gated brackets. True on-chain prevention (per-address round-1 cap +
single-use qualifiers) would require deploying a custom entry-requirement
extension; that is intentionally out of scope for this reference bot.
