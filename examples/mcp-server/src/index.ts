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
4. Entry fee: optional — ask if unstated. Needs token + human amount + winnersCount. Note some games enforce a minimum gameCreatorShareBps on-chain (see defaultGameFeePercentage in list_games); "100% to winner" may not be possible.
5. Gating: optional — NFT ownership (gatingTokenAddress) or allowlist (create_allowlist first, then gatingAllowlistTreeId).

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
