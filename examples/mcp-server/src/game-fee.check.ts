import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RpcProvider } from "starknet";
import { registerWriteTools } from "./tools/write.ts";

// Exercise the actual dry-run tool with a fake RPC fee response. No signing or
// broadcasting occurs; unknown reads fail instead of reaching a network.
type Result = { isError?: boolean; content: { text: string }[] };
let create!: (input: Record<string, unknown>) => Promise<Result>;
registerWriteTools({
  registerTool(name: string, _schema: unknown, handler: typeof create) {
    if (name === "create_tournament") create = handler;
  },
} as unknown as McpServer);
const env = {
  STARKNET_PRIVATE_KEY: "0x1", STARKNET_ACCOUNT_ADDRESS: "0x123",
  BUDOKAN_ADDRESS_SEPOLIA: "0x456", BUDOKAN_VIEWER_ADDRESS_SEPOLIA: "0x789",
  BUDOKAN_API_URL_SEPOLIA: "https://example.invalid", STARKNET_RPC_URL_SEPOLIA: "https://rpc.invalid",
};
const saved = new Map(Object.keys(env).map((name) => [name, process.env[name]]));
const originalCall = RpcProvider.prototype.callContract;
let recipient = "0x0";
let fee = 0;
let outage = false;
let reads = 0;
RpcProvider.prototype.callContract = async (call) => {
  assert.equal(call.contractAddress, "0x111");
  assert.equal(call.entrypoint, "game_fee_terms");
  reads++;
  if (outage) throw new Error("RPC unavailable");
  return [recipient, "0x0", "0x0", "0x0", `0x${fee.toString(16)}`];
};
try {
  Object.assign(process.env, env);
  const input = { chain: "sepolia", name: "Fee check", gameAddress: "0x111", playSeconds: 3600, dryRun: true };
  const paid = (share?: number) => create({ ...input, entryFee: { token: "STRK", amount: "1", gameCreatorShareBps: share } });
  const shareOf = (result: Result) => {
    assert.notEqual(result.isError, true, result.content[0]?.text);
    return JSON.parse(result.content[0]!.text).args.entryFee.gameFeeShare;
  };
  assert.equal(shareOf(await paid()), 0); // unlisted, fee-less game
  assert.equal((await paid(100)).isError, true);
  recipient = "0x222";
  fee = 500;
  assert.equal(shareOf(await paid()), 500);
  assert.equal(shareOf(await paid(600)), 600);
  assert.equal((await paid(499)).isError, true);
  outage = true;
  const failed = await paid();
  assert.equal(failed.isError, true);
  assert.match(failed.content[0]!.text, /RPC unavailable/);
  const beforeFree = reads;
  assert.notEqual((await create(input)).isError, true);
  assert.equal(reads, beforeFree); // free tournaments need no fee read
  console.log("MCP paid creation uses onchain fee terms and rejects invalid overrides/RPC failures");
} finally {
  RpcProvider.prototype.callContract = originalCall;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
