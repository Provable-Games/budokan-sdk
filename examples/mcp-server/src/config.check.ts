import assert from "node:assert/strict";
import { buildCreateTournamentCall } from "@provable-games/budokan-sdk";
import { budokanClient } from "./clients.ts";
import { chainConfig, requireGameCoreDeployment } from "./config.ts";

const names = ["MAINNET", "SEPOLIA"].flatMap((chain) => [
  `BUDOKAN_ADDRESS_${chain}`, `BUDOKAN_VIEWER_ADDRESS_${chain}`, `BUDOKAN_API_URL_${chain}`,
  `STARKNET_RPC_URL_${chain}`,
]);
const saved = new Map(names.map((name) => [name, process.env[name]]));
try {
  for (const name of names) delete process.env[name];
  assert.throws(() => requireGameCoreDeployment("mainnet"), /before writing/);
  const legacy = budokanClient("mainnet");
  assert.equal(legacy.clientConfig.budokanAddress, "");
  assert.equal(legacy.clientConfig.viewerAddress, "");
  assert.equal(legacy.clientConfig.rpcUrl, "");
  legacy.destroy();

  process.env.BUDOKAN_ADDRESS_SEPOLIA = "0x1234";
  assert.throws(() => chainConfig("sepolia"), /together/);
  process.env.BUDOKAN_VIEWER_ADDRESS_SEPOLIA = "0x5678";
  process.env.BUDOKAN_API_URL_SEPOLIA = "https://api.example.invalid";
  process.env.STARKNET_RPC_URL_SEPOLIA = "https://rpc.example.invalid";
  const deployment = requireGameCoreDeployment("sepolia");
  const client = budokanClient("sepolia");
  assert.equal(client.clientConfig.budokanAddress, deployment.budokanAddress);
  assert.equal(client.clientConfig.viewerAddress, deployment.viewerAddress);
  assert.equal(client.clientConfig.apiBaseUrl, deployment.apiBaseUrl);
  assert.equal(client.clientConfig.rpcUrl, process.env.STARKNET_RPC_URL_SEPOLIA);
  client.destroy();
  assert.throws(() => requireGameCoreDeployment("mainnet"), /before writing/);
  const call = buildCreateTournamentCall(deployment.budokanAddress, {
    creatorRewardsAddress: "0x1", gameAddress: "0x2", settingsId: 0,
    name: "Config check", description: "No transaction is submitted",
    schedule: { registrationStartDelay: 0, registrationEndDelay: 0,
      gameStartDelay: 60, gameEndDelay: 60, submissionDuration: 86400 },
    leaderboard: { ascending: false, gameMustBeOver: false },
  });
  assert.equal(call.contractAddress, client.clientConfig.budokanAddress);
  console.log("MCP deployment selection, write guard and read configuration passed");
} finally {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
