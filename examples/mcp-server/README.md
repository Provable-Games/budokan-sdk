# Budokan MCP Server

An [MCP](https://modelcontextprotocol.io) server that lets any MCP-capable agent (Claude Code, Claude Desktop, Cursor, …) read Budokan tournament data and **create and manage tournaments on Starknet**. Reads go through the Budokan/Denshokan indexer APIs; writes are signed locally with a wallet you control and use the SDK's pure calldata builders (`buildCreateTournamentCall`, `buildAddPrizeCall`, …) — the server never re-implements contract encoding.

## Quick start

```bash
cd examples/mcp-server
bun install
```

Register with Claude Code:

```bash
claude mcp add budokan -- bun run /path/to/budokan-sdk/examples/mcp-server/src/index.ts
```

Or in any MCP client config:

```json
{
  "mcpServers": {
    "budokan": {
      "command": "bun",
      "args": ["run", "/path/to/budokan-sdk/examples/mcp-server/src/index.ts"],
      "env": { "BUDOKAN_CHAIN": "mainnet" }
    }
  }
}
```

Reads work immediately with zero configuration. Writes need a wallet (below).

## Tools

| Tool | What it does |
| --- | --- |
| `list_tournaments` | Browse tournaments, filter by game/phase, paginated |
| `get_tournament` | One tournament: schedule, phase, entry fee, counts, budokan.gg URL |
| `get_leaderboard` | Submitted scores, best first |
| `get_prizes` | Escrowed sponsored prizes |
| `list_games` | Whitelisted games + per-game defaults + known fee tokens |
| `list_game_settings` | Settings presets registered for a game (`settings_id` values) |
| `create_tournament` | Create a tournament (signed). Supports entry fees, NFT token-gating, merkle allowlist-gating, open/fixed registration, `dryRun` |
| `create_allowlist` | Register an address snapshot as a merkle tree (signed) + store it in the merkle API for proof serving; returns a reusable `treeId`. Uniform allowance (`addresses` + `entriesPerAddress`) or tiered (`entries: [{address, count}]`) |
| `check_allowlist` | Check whether an address is on an allowlist tree (returns the entry proof) |
| `add_prize` | Sponsor an ERC-20 prize — approve + `add_prize` multicall (moves funds!), `dryRun` supported |
| `wallet_status` | Signing address, source, deployed?, STRK/ETH balances |
| `generate_wallet` | Create a fresh OpenZeppelin dev wallet (key stays in a 0600 keystore file) |
| `deploy_wallet` | DEPLOY_ACCOUNT once the generated address is funded with STRK |

## Wallet setup

Three ways to give the server a signer — **private keys never pass through the agent conversation** in any of them:

1. **Reuse a Starknet Foundry (sncast) account** — if you already use `sncast account create / import / deploy`, point the server at the same account by name:

   ```
   SNCAST_ACCOUNT=mainnet-deployer
   ```

   The server reads sncast's accounts file (`~/.starknet_accounts/starknet_open_zeppelin_accounts.json`, override with `SNCAST_ACCOUNTS_FILE`) under the matching network key (`alpha-mainnet` / `alpha-sepolia`). Selection is explicit by design — the server never auto-picks an account you didn't name, and a wrong name errors instead of falling back. `wallet_status` lists the available names when no signer is configured.

2. **Bring your own raw key** — set env vars on the server process:

   ```
   STARKNET_PRIVATE_KEY=0x…
   STARKNET_ACCOUNT_ADDRESS=0x…
   ```

3. **Generated dev wallet** — ask the agent to call `generate_wallet`. The key is written to `~/.budokan-mcp/wallet-<chain>.json` (mode 0600) and only the address is returned. Then:
   - send STRK to the returned address (fees are paid in STRK; a few STRK is plenty),
   - call `deploy_wallet`,
   - `create_tournament` / `add_prize` now sign with it.

Precedence: raw env key > `SNCAST_ACCOUNT` > generated keystore. Treat the dev wallet as a hot wallet: fund it with small amounts only.

## Configuration (all optional)

| Env var | Default | Purpose |
| --- | --- | --- |
| `BUDOKAN_CHAIN` | `mainnet` | Default chain (`mainnet` / `sepolia`); every tool also takes a per-call `chain` param |
| `SNCAST_ACCOUNT` | — | Name of a Starknet Foundry account to sign with |
| `SNCAST_ACCOUNTS_FILE` | `~/.starknet_accounts/starknet_open_zeppelin_accounts.json` | sncast accounts file location |
| `STARKNET_PRIVATE_KEY` / `STARKNET_ACCOUNT_ADDRESS` | — | Bring-your-own signing account (overrides `SNCAST_ACCOUNT`) |
| `STARKNET_RPC_URL_MAINNET` / `STARKNET_RPC_URL_SEPOLIA` | chain preset | Per-chain RPC overrides |
| `STARKNET_RPC_URL` | chain preset | RPC override for the default chain only (per-call `chain` params for the other network use its preset) |
| `RPC_API_KEY` | — | Sent as `Authorization: Bearer` to the RPC |
| `BUDOKAN_MCP_DIR` | `~/.budokan-mcp` | Keystore directory |
| `BUDOKAN_MCP_ACCOUNT_CLASS_HASH` | OpenZeppelin account | Class hash for generated wallets |

## How agents are guided

Three layers steer any MCP client through creation without hand-holding:

1. **Server instructions** (served on connect) — the creation checklist: which details to gather from the user (game, settings, schedule, fee, gating), to look ids up via `list_games` / `list_game_settings` instead of guessing, and to `dryRun` + confirm before broadcasting.
2. **Schemas** — required fields are enforced; missing ones fail validation with the exact field named. Parameter descriptions encode the known footguns (registered settings ids, share floors, `entriesPerAddress`/`entryLimit` interaction).
3. **Actionable errors** — on-chain reverts are extracted to one line (e.g. `Budokan: Settings id 999 is not found …`) with a hint naming the tool that resolves it, instead of the raw multi-KB RPC dump.

## Typical agent flow

1. `list_games` → pick a game address (note `controllerOnly` games can only be *played* with a Cartridge wallet — creating tournaments for them is fine).
2. `list_game_settings` → pick a registered `settingsId` (0 is only valid if the game registered it).
3. `create_tournament` with `dryRun: true` → show the human what will be sent.
4. `create_tournament` for real → returns the tournament id + `https://budokan.gg/tournament/<id>` link.
5. Optionally `add_prize` to sponsor a prize pool.

### Snapshot / allowlist tournaments

Allowlists are registered separately from tournaments and reusable across them:

1. `create_allowlist` with the snapshot addresses → registers a merkle tree on the deployed merkle validator (one signed tx) and stores the entries in the merkle API so budokan.gg can serve entry proofs. Returns a `treeId`.
2. `create_tournament` with `gatingAllowlistTreeId: <treeId>` (and usually `gatingEntryLimit: 1`).
3. `check_allowlist` to verify any address's eligibility/proof.

The per-leaf `entriesPerAddress` and the tournament's `gatingEntryLimit` interact as `min(count, entryLimit)` when `entryLimit > 0` — keep them consistent.

Allowance patterns (the leaf count is immutable once registered — new allowance = new tree):

- **One entry each**: default (`entriesPerAddress: 1`, `gatingEntryLimit: 1`).
- **Tiered**: `entries: [{ address: "0xwhale", count: 5 }, { address: "0x…", count: 1 }]` with `gatingEntryLimit: 0` (a non-zero limit caps every tier).
- **Effectively unlimited**: `entriesPerAddress: 2147483647` + `gatingEntryLimit: 0`. This is the enforced maximum: the chain accepts full u32, but larger counts overflow the merkle API's storage — the tree registers and then can never serve proofs.

Note: tiered `entries` needs the SDK from this repo (the example depends on `file:../..`); it lands on npm with the next SDK release.

Player-side actions that need the *player's* signature (entering, submitting scores, claiming) are deliberately not exposed as signed tools — players do those on budokan.gg; the tournament links returned by the tools take them straight there.

## Verification

`bun smoke.mjs` spawns the server over stdio and exercises every tool: live mainnet reads, wallet generation into a temp keystore (`SMOKE_KEYSTORE_DIR`), and dry-run `create_tournament` / `add_prize` (no funds moved). Typecheck with `bun run typecheck`.
