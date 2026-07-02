# Plan: allowlist-gated brackets (merkle) + open-bracket registration phase

**Audience:** an engineer/agent implementing this from scratch (no prior conversation context).
**Repo:** `budokan-sdk` — SDK in `src/`, Telegram bot in `examples/telegram-controller-bot/server/`.
**Related issue:** #51 (escrow contract) — this plan is the *off-chain* half of it (registration + assignment + allowlist gating), **without** on-chain escrow or VRF.

> **Design principle — keep it generalized across apps (web client / Telegram / Discord).**
> The SDK is deliberately **signing-agnostic and storage-agnostic**: it returns plain
> JSON-serializable state (`BracketState`) and arrays of `Call` objects, and takes injected
> reader callbacks (`MatchReader`). The *consumer* owns persistence, signing, and UI.
> **Anything app-agnostic (merkle tree create/fetch, signup→assign→deploy transitions) belongs
> in `src/`, not the bot** — otherwise a Discord bot or web client has to reimplement it. The bot
> should stay a thin adapter: chat UI + session signing + persistence, calling SDK functions.
> This plan is scoped so the reusable logic lives in the SDK and only Telegram-specific glue
> lives under `examples/telegram-controller-bot/`.

---

## 1. Goal

Close the "round-1 client bypass" hole in brackets and add controlled entry:

- **Every round-1 match is gated by a merkle allowlist** of its participants, `entry_limit: 1` per person — so only the intended players can enter (via the bot *or* directly on budokan.gg), each once. (Round > 1 is already gated on winning the feeder via the `tournament_validator` extension — leave that as is.)
- **Open brackets get a registration ("initializing") phase:** players sign up first; once the field is full the bot creates the gated tournaments and players **enter again** (pay) into their assigned match. **No escrow** — fees are paid at entry, not held during signup.
- **Closed brackets** get the same merkle gating (roster = allowlist), no registration phase.

## 2. Background — current bracket architecture

Read `src/brackets/DESIGN.md` and `src/brackets/index.ts` first. Key points:

- A "bracket" = N Budokan tournaments, one per match (4 players → 3 tournaments, 8 → 7, 16 → 15). Single-elimination.
- **Round > 1 gating (already done):** each round>1 match is created with an `entry_requirement` = the `tournament_validator` extension, config `[qualifierType, qualifyingMode, topPositions, ...feederTournamentIds]` (built by `buildTournamentValidatorConfig`). Entry needs a `QualificationProof::Extension([feederTid, winnerTokenId, position])` (`buildTournamentQualificationProof`). See `gatedMatchCreateCall` + `bracketEntryCalls` in `src/brackets/index.ts`.
- **Round 1 is currently UNGATED** — an ordinary open tournament. That's the hole this plan closes.
- SDK bracket entry points: `createBracket(opts)` → `BracketState`; `roundMatchCreateCalls(state, round)` → `[{matchId, call}]` (the round's `create_tournament` calls, staggered schedule, round>1 gated); `bracketEntryCalls(state, matchId, playerAddress)` → the `enter_tournament` calls (attaches the qualification proof for gated rounds); `attachMatchTournament(state, matchId, tid)` after reading the created id from the receipt.
- **Bot deploy paths** (`examples/telegram-controller-bot/server/src/commands/bracket.ts`):
  - `deployResolved` — CLOSED brackets: creates the whole tree (one `create_tournament` per match, per round, reading each tid from the receipt), then **enters all round-1 players in one multicall** (`enter_tournament` mints the game token to each `player_address`).
  - `deployPaidUpfront` — OPEN brackets: creates the whole tree UP FRONT with placeholder players (`0x0`); players tap **Join** (channel button `bjoin:<id>` → `joinViaButton` → `enterPaidSlot`) to pay + enter their slot on the fly. **This is what changes** — see Phase 4.
  - `enterPaidSlot(...)` assigns the next slot + runs the joiner's session to `enter_tournament` + escrow the fee (`bracketFeePrizeCalls`).
- **Note (removed earlier, being partly re-introduced):** there used to be a "register then deploy-at-fill" model for open brackets; it was removed in favor of deploy-upfront. Phase 4 re-introduces a registration phase (with allowlist gating this time).

## 3. Confirmed product decisions

- **No escrow.** Signup is free (register intent). Players **pay when they enter**, after the gated tournaments exist. (If they signed up but the bracket fills, they "enter again" to actually pay in.)
- **Allowlist granularity: per-match** (each round-1 match's tree = its 2 assigned players). This strictly binds a player to their assigned match and blocks entering a different match. (Per-bracket — one tree of everyone — is simpler but lets a participant self-enter the wrong match; do **not** use it.)
- **`entry_limit: 1`** per person on the merkle validator.
- **Random assignment** of signups to round-1 slots: **off-chain, deterministic shuffle in the SDK** (`seeding: "random"` + a caller-supplied `shuffleSeed`, reused by `assignRegistrants` — see Phase 4a). The bot supplies the only non-deterministic input, a `shuffleSeed` derived at fill time (`Math.random()`/`Date.now()` are fine there — the bot is Node, unlike SDK/workflow sandboxes). Keeping the shuffle *itself* deterministic and in the SDK makes it testable and reusable by Discord/web clients. (On-chain VRF is the #51 trustless version — out of scope here.)
- **Closed brackets** get the same per-match merkle gating (each round-1 pair is a tree).

## 4. Dependencies & key facts

### Merkle infra (EXISTS)
- **Merkle validator** deployed; address via `extensionAddressFor(chain, "merkle")` (`src/extensions/index.ts`), which reads `getExtensionAddresses()` from `@provable-games/metagame-sdk`. **Verify it returns a non-empty `merkleValidator` for both `mainnet` and `sepolia`** before building; it throws if absent.
- **Merkle validator config** = `buildMerkleConfig({ treeId })` → `[String(treeId)]`. So the validator references a **pre-registered tree by id** — the tree (allowlist) must be registered on-chain (which assigns the id) and stored in the merkle service first. The SDK's Phase-2 wrappers cover both steps.
- **Merkle tree service ("Merkle Stack"):** `https://merkle-api.up.railway.app` (Railway project `Merkle Stack`, workspace "Provable Games"). It stores registered trees for the budokan merkle validator + serves proofs. **Reachable** (responds), but ⚠️ **its Railway build has been failing since 2026-05-20** (`pnpm install --frozen-lockfile`) — it's serving a stale deploy. Recommend fixing that build for reliability (separate repo).
- **metagame-sdk merkle API — CORRECTED (verified against `@provable-games/metagame-sdk@0.1.13`):** the functional helpers (`createMerkleTree`, `fetchMerkleProof`, `getMerkleApiUrl`, `setMerkleApiUrl`) are **deprecated** and `createMerkleTree` requires the on-chain tree id (it only *stores*, it doesn't register). Tree registration is on-chain and only the **`MerkleClient` class** (`@provable-games/metagame-sdk/merkle`) exposes it: `buildTreeCalldata(entries, validator)` (build the `create_tree` call), `parseTreeIdFromEvents(events, validator)` (read the assigned id), `createTree({ treeId, name, description, entries })` (store), `getProof(treeId, address)` (returns `{ qualification: [count, ...proof], ... }`). The SDK's `src/extensions/merkle.ts` wraps `MerkleClient` and is chain-aware (`chainId` from the short chain name; optional `apiUrl` override).

### Entry with a merkle proof
- `buildEnterTournamentCall(budokanAddress, args)` (`src/calldata/index.ts`) takes `qualification?: { kind: "extension"; data: string[] } | { kind: "nft"; tokenId }`. For a merkle-gated round-1 match, `data` = the merkle proof span from the merkle service (see metagame-sdk `fetchMerkleProof` / `buildQualificationProof` / `buildExtensionProof` — confirm which returns the felt span the merkle validator expects).

### Conventions (follow these)
- **Package manager: `bun` only** (never npm/yarn/pnpm) for `budokan-sdk`. Bot typecheck: `cd examples/telegram-controller-bot/server && bun run typecheck`. SDK build/test: `bun run build`, `bun test`.
- **`main` is protected** (requires 1 approving review + AI-reviewer CI). Work on a branch, open a PR; the human merges. Commit trailer: `Co-Authored-By: ...`.
- **SDK releases:** bump `package.json`, merge, then `gh release create vX.Y.Z --target main` → `publish.yml` publishes to npm. The **bot depends on the *published* SDK** (`examples/telegram-controller-bot/server/package.json`, `@provable-games/budokan-sdk`), so **any new SDK export used by the bot needs a release + a dep bump first** (or a local `bun link` for dev).
- **Bot deploy:** Railway project `budokan-telegram`, service `telegram-bot`, auto-deploys from `budokan-sdk` `main`. Merging bot changes redeploys it.
- Chain constants in `src/chains/constants.ts`. Current: sepolia budokan `0x07edaa23…`, mainnet `0x012eb6…`.

## 5. Implementation phases

### Phase 1 — SDK: merkle allowlist gating for round-1 ✅ IMPLEMENTED
File: `src/brackets/index.ts` (+ `src/extensions/index.ts` for the merkle config).

Implemented: `BracketState.roundOneTreeIds?: Record<matchId, treeId>` + `CreateBracketOptions.roundOneTreeIds`; `attachRoundOneTree(state, matchId, treeId)` to attach a tree after registering it; a round-1 merkle branch in `gatedMatchCreateCall` (sets the merkle `entry_requirement`, `entryLimit: 1`); and a `proof?` argument on `bracketEntryCalls(state, matchId, addr, proof?)` that attaches the allowlist proof as `QualificationProof::Extension`. Tests in `tests/brackets.test.ts` ("round-1 merkle allowlist gating").

1. Extend `CreateBracketOptions` / `BracketState` with an optional **per-match round-1 allowlist**: e.g. `roundOneTreeIds?: Record<matchId, treeId>` (or accept the allowlist addresses and let the caller pass treeIds after creating the trees). Cleanest: the caller (bot) creates the trees and passes `treeId` per round-1 match into the state before `roundMatchCreateCalls(state, 1)`.
2. In `gatedMatchCreateCall` / the round-1 create path, when a round-1 match has a `treeId`, set its `entry_requirement`. **Match the real `EntryRequirementArgs` shape** (see `gatedMatchCreateCall`, `src/brackets/index.ts:461`) — it is `{ entryLimit, type: { kind, address, config } }`, NOT a flat `{ address, config, entryLimit }`:
   ```ts
   entryRequirement = {
     entryLimit: 1,
     type: {
       kind: "extension",
       address: extensionAddressFor(state.chain, "merkle"),
       config: buildMerkleConfig({ treeId }),
     },
   };
   ```
   (Round-1 currently passes no entry requirement — add this branch alongside the existing `state.gated && match.round > 1` tournament-validator branch.)
3. In `bracketEntryCalls`, for a round-1 merkle-gated match, attach `qualification: { kind: "extension", data: <merkleProof> }`. The proof is supplied by the caller (the bot fetches it), so add a way to pass it in (e.g. `bracketEntryCalls(state, matchId, playerAddress, proof?)`), or a dedicated `bracketMerkleEntryCall(...)`.
4. Add unit tests (calldata shape) mirroring the existing bracket tests in `tests/brackets.test.ts`.
5. **Release** a new SDK version; bump the bot's dep.

### Phase 2 — SDK: merkle allowlist service wrappers (app-agnostic) ✅ IMPLEMENTED
**Put this in the SDK, not the bot** — creating a tree and fetching a proof are identical for every
consumer (web client, Discord, Telegram); only the *call to* them is app-specific.

**⚠️ Reality correction (verified against `@provable-games/metagame-sdk@0.1.13`):** creating a tree is
**NOT** a single API call. The tree id is assigned **on-chain** by the merkle validator's `create_tree`,
so tree creation is a *signed* two-step flow, and the functional `createMerkleTree(...)` helper actually
*requires* the on-chain id as input (it only stores an already-registered tree in the API). The
`MerkleClient` class (`@provable-games/metagame-sdk/merkle`) is the only API that can build the
registration call and parse the id. To keep the SDK signing-agnostic, the wrappers therefore **return
the registration `Call`** rather than a one-shot `createAllowlistTree(...) → treeId`.

Implemented in `src/extensions/merkle.ts` (exported from `src/index.ts`):
- `buildRegisterAllowlistTreeCall({ chain, addresses, entriesPerAddress?, apiUrl? }) → { call, entries }` — local/pure. `call` is the on-chain `create_tree` call the caller signs; `entries` (each `count: 1` by default) are handed to `storeAllowlistTree`.
- `parseAllowlistTreeId({ chain, events, apiUrl? }) → number | null` — reads the assigned tree id from the register-tree receipt events.
- `storeAllowlistTree({ chain, treeId, name, description, entries, apiUrl? }) → Promise<void>` — persists the tree in the merkle API so proofs can be served.
- `getAllowlistProof({ chain, treeId, address, apiUrl? }) → Promise<string[]>` — returns the API's `qualification` span (`[count, ...proof]`), the felt span the validator's `validate_entry` expects.
- Unit tests: `tests/extensions.test.ts` (offline — `buildRegisterAllowlistTreeCall` targets the validator, entries default to count 1, validation throws). Network calls (`storeAllowlistTree`, `getAllowlistProof`) are exercised on sepolia (§6).
- **Release** with Phase 1 (same version bump) so the bot's dep bump picks up both.

**Bot side (thin):** the only Telegram-specific piece is wiring config — add `merkleApiUrl?` to the
bot's `config.ts` (`MERKLE_API_URL` env, default `https://merkle-api.up.railway.app`) and pass it as
the `apiUrl` arg. No merkle logic in the bot. A Discord bot / web client would do the same one-liner.
The bot's deploy flow becomes: `buildRegisterAllowlistTreeCall` → sign the `call` (operator session) →
`parseAllowlistTreeId(receipt.events)` → `storeAllowlistTree` → `attachRoundOneTree(state, matchId, treeId)`.

### Phase 3 — Bot: closed brackets gated (`deployResolved`)
Uses the SDK wrappers from Phase 2 + the round-1 gating from Phase 1. This phase is genuinely
bot-side (it orchestrates signing + persistence), but every merkle/bracket primitive is imported
from the SDK.
- Before creating round-1 matches, register a tree per round-1 pair: `buildRegisterAllowlistTreeCall({ chain, addresses: [playerA, playerB] })` (SDK) → sign the `call` (operator session) → `parseAllowlistTreeId(receipt.events)` → `storeAllowlistTree(...)` → `attachRoundOneTree(state, matchId, treeId)`. (Tree registration can be batched into one multicall across matches; parse each id from the receipt.)
- Then `roundMatchCreateCalls(state, 1)` (round-1 now merkle-gated) → attach tids.
- Enter each player with `getAllowlistProof({ chain, treeId, address })` (SDK) passed into `bracketEntryCalls(state, matchId, addr, proof)` (replace the current ungated round-1 entry multicall). Keep it a single multicall where possible.

### Phase 4 — Open brackets: registration phase
Split into an **SDK half (pure, reusable) and a bot half (chat UI + signing)**.

#### 4a — SDK: registration state + pure assignment transitions ✅ IMPLEMENTED
The signup → assign → deploy *transitions* are pure functions on `BracketState`, exactly the kind of
logic the SDK already owns. Implemented in `src/brackets/index.ts` (exported from `src/index.ts`):
- Reconciled the state type: `BracketState.status` is now `"registering" | "running" | "complete"` and `BracketState.registrants?: Registrant[]` holds signups pre-assignment.
- `createRegisteringBracket(opts)` → a `BracketState` with `status: "registering"`, capacity `size` (power of two), no players/matches yet.
- `addRegistrant(state, { address, name? })` / `removeRegistrant(state, address)` → updated state (dedupe by address case-insensitively; `addRegistrant` enforces capacity = `size`; both reject a non-registering bracket).
- `assignRegistrants(state, { seeding?, shuffleSeed? }) → BracketState` — shuffles the registrants and builds the running bracket by delegating to `createBracket`, so seeding, byes, tree construction, and the **deterministic shuffle** all stay in one place. Defaults `seeding: "random"`; the caller supplies `shuffleSeed` (the bot derives one from wall-clock at fill time — the only non-deterministic input, and it lives in the app).
- Unit tests: `tests/brackets.test.ts` ("registration phase") — includes a determinism check (same seed → same assignment).

#### 4b — Bot: chat glue over the SDK transitions
- **Registration ("initializing") phase:** replace the up-front placeholder deploy with a signup list. The channel card shows "Sign up" (capture chatId + address via the tapper's session, like `enterPaidSlot` does for `playerChats`) → call `addRegistrant(state, …)` and persist. Show progress until capacity/deadline.
  - Reuse the removed-registration patterns if useful (git history), but the assignment logic now lives in the SDK (4a).
- **On full / deadline:** call `assignRegistrants(state, { shuffleSeed })` (SDK), then for each round-1 pair register a tree via `buildRegisterAllowlistTreeCall`/`parseAllowlistTreeId`/`storeAllowlistTree` (SDK, Phase 2), `attachRoundOneTree` the `treeId`s, and deploy via `roundMatchCreateCalls(state, 1)`.
- **Entry:** players **enter again** (pay) into their assigned match — a "Play/Enter now" DM/button per signed-up player (their chat is known from signup) that runs their session to `enter_tournament` (+ pay the fee via `bracketFeePrizeCalls`) with the merkle proof from `getAllowlistProof(...)`. The allowlist blocks anyone else. (Do NOT auto-enter from the bot unless you want the bot to pay — the design is "they enter again", i.e. each player pays their own.)
- Round-1 game starts at the scheduled start time (the existing start-delay step still applies).

## 6. Testing / verification
- SDK: `bun test` (add merkle-gating calldata tests).
- Bot: `bun run typecheck`.
- **On-chain, sepolia:** create a small closed bracket (2 or 4 players you control) → confirm a non-allowlisted address **cannot** enter a round-1 match via budokan.gg (validator reverts), and an allowlisted one can, **once**. Then an open bracket: sign up → fill → confirm gated tournaments created + players can enter with proofs and outsiders can't.
- Verify the merkle service actually returns a valid `treeId` + proof end-to-end (it's serving a stale deploy — sanity-check it works before relying on it).

## 7. Open decisions
- **Signup capture:** does "sign up" require the player to `/connect` (so we know their address for the allowlist)? Almost certainly yes — the allowlist is by address, so signup must resolve the player's address (via their session), not just their Telegram id.
- **Under-fill / cancel:** if a bracket never fills, nobody has paid (no escrow) so there's nothing to refund — just don't deploy. Decide a deadline/timeout to abandon a signup that never fills.
- **Merkle proof format:** confirm exactly which metagame-sdk helper produces the felt span the deployed merkle validator's `validate_entry` expects (test on sepolia).
- **Per-match trees at scale:** a 16-player bracket = 8 round-1 trees. Confirm the merkle service + gas handle that; batch tree creation if the API supports it.

## 8. Gotchas
- Bot uses the **published** SDK — the new exports from Phase 1 (round-1 merkle gating), Phase 2 (`createAllowlistTree`/`getAllowlistProof`), and Phase 4a (registration transitions) must be released together (or `bun link`ed) before the Phase 3/4b bot glue can compile.
- `enter_tournament` mints the game token to `player_address` (entering = minting) — no separate mint needed.
- The merkle-api build is broken (stale deploy serving) — flag/fix it or it's a latent outage.
- Keep the existing round>1 `tournament_validator` gating untouched; this only adds gating to round 1.
- Session model: signing stays in DMs (sessions key off the DM chat id); channel buttons pass `from.id`. Don't run signup/entry signing from a group chat id.
