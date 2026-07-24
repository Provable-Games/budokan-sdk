#!/usr/bin/env bun
// Budokan MCP server — stdio transport.
//
// Exposes Budokan reads (tournaments, leaderboards, prizes, games,
// settings) and signed writes (create_tournament, add_prize) plus a
// dev-wallet lifecycle (generate → fund → deploy). See README.md for
// configuration.
//
// stdout is the MCP protocol channel — all logging must go to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReadTools } from "./tools/read.ts";
import { registerWriteTools } from "./tools/write.ts";
import { registerWalletTools } from "./tools/wallet.ts";
import { DEFAULT_CHAIN } from "./config.ts";

const server = new McpServer(
  { name: "budokan", version: "0.0.1" },
  {
    instructions: `Budokan tournament platform on Starknet. Reads need no setup; writes sign with the server's configured wallet and SPEND REAL FUNDS on mainnet.

Creating a tournament — gather these from the user before calling create_tournament; do not guess:
1. Game: call list_games; if the user's game name doesn't match an entry, ask. On less-active chains prefer a game recent tournaments actually use (list_tournaments shows gameAddress).
2. Settings: call list_game_settings for the chosen game and pick a registered id — unregistered ids (including 0 for some games) revert on-chain. If several presets exist and the user didn't specify, ask.
3. Schedule: two forms — absolute unix timestamps (gameEndTime, plus registrationStartTime/registrationEndTime for a fixed registration window) or durations from now (playSeconds etc.). Prefer absolute times when the user names specific dates/times; ask whether registration is open (join during play — the default) or a fixed window before play.
4. Entry fee: optional — ask if unstated. Needs token + human amount + winnersCount. Shares (tournamentCreatorShareBps/gameCreatorShareBps/refundShareBps) are bps taken off the top; the remainder funds the winners' pool. To maximise the pool, set tournamentCreator + refund to 0 and gameCreator to its enforced minimum (defaultGameFeePercentage×100 in list_games — also the default) — a protocol fee is snapshotted on top and is NOT settable, so "100% to winners" is never literally possible. Prize split: exponential/linear/uniform, or "custom" with distributionWeights = per-place percentages summing to 100 (one per winnersCount place).
5. Gating: optional — NFT ownership (gatingTokenAddress) or allowlist (create_allowlist first, then gatingAllowlistTreeId). With a tiered allowlist, leave gatingEntryLimit at 0 or it caps every address's per-leaf count.
6. Token behaviour: soulbound (default false → entries are transferable game NFTs; true → non-transferable, can't be sold or moved). Ask when the spec implies identity-bound entries (e.g. allowlist/holder tournaments) but doesn't say. (paymaster also exists but is highly irrelevant right now — no game has one funded — and is only exposed for a future update; leave it unset.)
7. Other timings/behaviour worth confirming when unstated: submission window after play (submissionSeconds, default 24h), whether lower score wins (leaderboardAscending), and whether the game run must be finished before submitting (gameMustBeOver).

Config-awareness: create_tournament exposes more than a typical spec covers. Before broadcasting, scan the options the user did NOT mention — soulbound, submission window, leaderboard direction, gating entry limit, entry-fee shares/winnersCount, registration window vs open — and briefly surface the defaults you're about to apply so the user can catch anything missed, rather than silently accepting defaults.

Before broadcasting: call create_tournament with dryRun:true and show the user a summary for confirmation. Check wallet_status once per session (funded + deployed). Never ask the user to paste a private key into the conversation — keys are configured on the server process (SNCAST_ACCOUNT or STARKNET_PRIVATE_KEY env) or via generate_wallet.

add_prize transfers the sponsor's tokens into escrow immediately — confirm amount and token with the user first. Tournament/allowlist creation cannot be undone; funds committed to prizes and fees are distributed by the contract, not refundable by this server.`,
  },
);

registerReadTools(server);
registerWriteTools(server);
registerWalletTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[budokan-mcp] ready (default chain: ${DEFAULT_CHAIN})`);
