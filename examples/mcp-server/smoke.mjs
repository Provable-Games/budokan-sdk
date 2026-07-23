// End-to-end smoke test: spawns the server over stdio and calls every
// tool. Reads hit the live mainnet indexer; the wallet + write tools use
// a throwaway keystore and dryRun, so nothing is signed or broadcast.
//
//   bun smoke.mjs                     # keystore in a temp dir
//   SMOKE_KEYSTORE_DIR=… bun smoke.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const keystoreDir =
  process.env.SMOKE_KEYSTORE_DIR ?? mkdtempSync(join(tmpdir(), "budokan-mcp-smoke-"));
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command: "bun",
    args: ["run", join(SERVER_DIR, "src/index.ts")],
    env: {
      ...process.env,
      BUDOKAN_MCP_DIR: keystoreDir,
      BUDOKAN_CHAIN: "sepolia",
    },
  }),
);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  console.log(`\n=== ${name}${res.isError ? " (isError)" : ""} ===`);
  console.log(text.length > 900 ? text.slice(0, 900) + " …[truncated]" : text);
  return text;
}

await call("wallet_status", {}); // before any wallet exists → configured:false
await call("list_games", { chain: "mainnet" });
await call("list_tournaments", { chain: "mainnet", limit: 2 });
const listed = JSON.parse(await call("list_tournaments", { chain: "mainnet", limit: 1 }));
const id = listed.tournaments?.[0]?.id;
if (id) {
  await call("get_tournament", { chain: "mainnet", tournamentId: id });
  await call("get_leaderboard", { chain: "mainnet", tournamentId: id });
  await call("get_prizes", { chain: "mainnet", tournamentId: id });
}
await call("list_game_settings", {
  chain: "mainnet",
  gameAddress: JSON.parse(await call("list_games", { chain: "mainnet" })).games[0].contractAddress,
  limit: 3,
});
await call("generate_wallet", {}); // sepolia keystore in SMOKE dir
await call("wallet_status", {}); // now configured, undeployed, zero balance
await call("create_tournament", {
  chain: "sepolia",
  name: "Smoke Test Cup",
  description: "dry run only",
  gameAddress: "0x0444834e7b74749ee43a5e73ecf9d69ded92cecdf51a4dcbbdcb44b53bfbb642",
  playSeconds: 3600,
  entryFee: { token: "STRK", amount: "1.5", winnersCount: 3 },
  dryRun: true,
});
await call("create_allowlist", {
  chain: "sepolia",
  name: "Smoke Snapshot",
  addresses: [
    "0x01234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
    "0x1234567890ABCDEF1234567890abcdef1234567890abcdef1234567890abcd", // dupe, different casing
    "0x02222222222222222222222222222222222222222222222222222222222222",
  ],
  dryRun: true,
});
// Schedule-encoding regression check (PR #80 review): the end fields must be
// durations of their own window, not cumulative offsets from creation.
{
  const dry = JSON.parse(
    await call("create_tournament", {
      chain: "sepolia",
      name: "Sched Encode Check",
      gameAddress: "0x0444834e7b74749ee43a5e73ecf9d69ded92cecdf51a4dcbbdcb44b53bfbb642",
      registrationDelaySeconds: 3600,
      registrationSeconds: 86400,
      stagingSeconds: 7200,
      playSeconds: 172800,
      dryRun: true,
    }),
  );
  const s = dry.args.schedule;
  const expected = {
    registrationStartDelay: 3600,
    registrationEndDelay: 86400,
    gameStartDelay: 3600 + 86400 + 7200,
    gameEndDelay: 172800,
    submissionDuration: 86400,
  };
  if (JSON.stringify(s) !== JSON.stringify(expected)) {
    throw new Error(`schedule encoding regression: got ${JSON.stringify(s)}`);
  }
  console.log("\nschedule encoding OK");
}

await call("create_allowlist", {
  chain: "sepolia",
  name: "Tiered Smoke Snapshot",
  entries: [
    { address: "0x01234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd", count: 5 },
    { address: "0x02222222222222222222222222222222222222222222222222222222222222", count: 1 },
  ],
  dryRun: true,
});
await call("create_tournament", {
  chain: "sepolia",
  name: "Allowlist Cup",
  gameAddress: "0x0444834e7b74749ee43a5e73ecf9d69ded92cecdf51a4dcbbdcb44b53bfbb642",
  playSeconds: 3600,
  gatingAllowlistTreeId: 7,
  gatingEntryLimit: 1,
  dryRun: true,
});
await call("check_allowlist", {
  chain: "mainnet",
  treeId: 1,
  address: "0x0000000000000000000000000000000000000000000000000000000000000001",
});
await call("add_prize", {
  chain: "sepolia",
  tournamentId: "1",
  token: "STRK",
  amount: "10",
  winnersCount: 3,
  dryRun: true,
});

await client.close();

// --- sncast accounts-file interop -----------------------------------------
// Second server instance configured with a synthetic sncast accounts file
// (never the user's real ~/.starknet_accounts) and SNCAST_ACCOUNT set.
import { writeFileSync } from "node:fs";

const sncastFile = join(keystoreDir, "sncast-accounts.json");
writeFileSync(
  sncastFile,
  JSON.stringify({
    "alpha-sepolia": {
      "smoke-deployer": {
        private_key: "0x1",
        public_key: "0x2",
        address: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
        deployed: true,
        type: "open_zeppelin",
      },
    },
  }),
);
const sncastClient = new Client({ name: "smoke-sncast", version: "0.0.1" });
await sncastClient.connect(
  new StdioClientTransport({
    command: "bun",
    args: ["run", join(SERVER_DIR, "src/index.ts")],
    env: {
      ...process.env,
      BUDOKAN_MCP_DIR: join(keystoreDir, "unused"),
      BUDOKAN_CHAIN: "sepolia",
      SNCAST_ACCOUNTS_FILE: sncastFile,
      SNCAST_ACCOUNT: "smoke-deployer",
    },
  }),
);
const status = await sncastClient.callTool({ name: "wallet_status", arguments: {} });
console.log("\n=== wallet_status (sncast) ===");
console.log(status.content?.[0]?.text);
const badEnv = await sncastClient.callTool({
  name: "create_tournament",
  arguments: { name: "x", gameAddress: "0x1", playSeconds: 3600, dryRun: true },
});
console.log("\n=== create_tournament dryRun signs as sncast account ===");
console.log(badEnv.content?.[0]?.text?.slice(0, 200));
await sncastClient.close();

console.log("\nSMOKE DONE");
