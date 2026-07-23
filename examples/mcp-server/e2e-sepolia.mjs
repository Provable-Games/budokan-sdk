// Live end-to-end test on sepolia — SIGNS AND BROADCASTS REAL TRANSACTIONS
// (testnet funds). Requires a funded signer, e.g.:
//
//   SNCAST_ACCOUNT=deployer bun e2e-sepolia.mjs
//
// Flow: wallet_status → list_games → create_allowlist (real tx) →
// create_tournament gated on the tree (real tx) → check_allowlist →
// get_tournament.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "e2e", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: "bun",
    args: ["run", join(SERVER_DIR, "src/index.ts")],
    env: { ...process.env, BUDOKAN_CHAIN: "sepolia" },
  }),
);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  console.log(`\n=== ${name}${res.isError ? " (isError)" : ""} ===`);
  console.log(text.length > 1400 ? text.slice(0, 1400) + " …[truncated]" : text);
  if (res.isError) {
    console.error("\nAborting: tool call failed.");
    process.exit(1);
  }
  return JSON.parse(text);
}

const status = await call("wallet_status", {});
if (!status.configured || !status.deployed) {
  console.error("Signer not ready — configure SNCAST_ACCOUNT or deploy the wallet first.");
  process.exit(1);
}

const { games } = await call("list_games", {});
// Number Guess is the game actually exercised on sepolia (all recent
// tournaments there use it); other whitelist entries can be stale on testnet.
const game = games.find((g) => g.name === "Number Guess") ?? games[0];
console.log(`\nUsing game: ${game.name} (${game.contractAddress})`);

// Not every game accepts settings id 0 — the contract validates the id
// against the game's registered settings, so resolve a real one first.
const { settings } = await call("list_game_settings", { gameAddress: game.contractAddress, limit: 5 });
const settingsId = settings[0]?.id ?? 0;
console.log(`Using settingsId: ${settingsId} (${settings[0]?.name ?? "fallback 0"})`);

const allowlist = await call("create_allowlist", {
  name: "MCP e2e snapshot",
  description: "Test allowlist created via the Budokan MCP server",
  addresses: [
    status.address, // the signer itself — lets us verify a positive proof
    "0x0000000000000000000000000000000000000000000000000000000000000042",
  ],
});
if (allowlist.treeId === undefined) process.exit(1);

const tournament = await call("create_tournament", {
  name: "MCP e2e Cup",
  description: "Allowlist-gated test tournament created by the Budokan MCP server.",
  gameAddress: game.contractAddress,
  settingsId,
  playSeconds: 3600,
  gatingAllowlistTreeId: allowlist.treeId,
  gatingEntryLimit: 1,
});

await call("check_allowlist", { treeId: allowlist.treeId, address: status.address });
await call("check_allowlist", {
  treeId: allowlist.treeId,
  address: "0x0000000000000000000000000000000000000000000000000000000000000007",
});

if (tournament.tournamentId) {
  // The indexer may lag the receipt by a few seconds.
  await new Promise((r) => setTimeout(r, 8000));
  await call("get_tournament", { tournamentId: tournament.tournamentId });
}

await client.close();
console.log("\nE2E DONE");
