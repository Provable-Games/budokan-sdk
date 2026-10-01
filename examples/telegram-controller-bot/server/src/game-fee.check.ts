import assert from "node:assert/strict";
import { mock } from "bun:test";
import { RpcProvider } from "starknet";
import type { Config } from "./config.ts";
import type { TelegramApi } from "./telegram-api.ts";
import type { Call } from "@provable-games/budokan-sdk";
import * as games from "./catalog/games.ts";

// Drive the real create wizard and token fee reader. Stub unrelated catalog,
// wallet and Telegram services; no network, signing or filesystem writes.
mock.module("./catalog/games.ts", () => ({
  ...games,
  gamesForChain: async () => [
    { contractAddress: "0x111", name: "Unlisted game" },
    { contractAddress: "0x222", name: "Other game" },
  ],
}));
mock.module("./catalog/settings.ts", () => ({
  fetchSettings: async () => ({ data: [], total: 0, limit: 5, offset: 0 }),
  fetchSetting: async () => null,
  formatSettingsDetails: () => "",
}));
mock.module("./commands/bracket.ts", () => ({ start: async () => {} }));
const submissions: Call[][] = [];
mock.module("./controller-account.ts", () => ({
  resolveAccount: async () => ({ ok: true, data: {
    address: "0x123", account: { execute: async (calls: Call[]) => {
      submissions.push(calls);
      throw new Error("Test stopped at signing boundary");
    } },
  } }),
}));
const { start, handleAnswer, isPending, cancel } = await import("./commands/create.ts");
const config: Config = {
  telegramBotToken: "test", chain: "sepolia", botPublicUrl: "http://localhost",
  httpPort: 8787, dataDir: "/unused", apiUrl: "https://example.invalid",
  rpcUrl: "https://rpc.invalid", budokanAddress: "0x456", viewerAddress: "0x789",
};
const messages: string[] = [];
const api = { sendMessage: async (_id: string, text: string) => { messages.push(text); } } as unknown as TelegramApi;
const chatId = "fee-check";
const answer = (text: string) => handleAnswer(api, config, chatId, text);
const last = () => messages.at(-1)!;
let recipient = "0x333";
let fee = 500;
let outage = false;
let pausedRead: { started: () => void; wait: Promise<void> } | undefined;
function pauseRead() {
  let signal!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { signal = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  pausedRead = { started: signal, wait };
  return { started, release: () => { pausedRead = undefined; release(); } };
}
const reads: string[] = [];
const originalCall = RpcProvider.prototype.callContract;
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("Unexpected network call"); }) as unknown as typeof fetch;
RpcProvider.prototype.callContract = async (call) => {
  assert.equal(call.entrypoint, "game_fee_terms");
  reads.push(call.contractAddress);
  if (pausedRead) { pausedRead.started(); await pausedRead.wait; }
  if (outage) throw new Error("RPC unavailable");
  return [recipient, "0x0", "0x0", "0x0", `0x${fee.toString(16)}`];
};
async function begin(paid = true) {
  await start(api, chatId, "sepolia");
  for (const text of ["1", "1", "Fee check", "skip", "1", paid ? "2" : "1"]) await answer(text);
  if (paid) await answer("1"); // token; next prompt asks for amount
}
async function finishFee(editing = false) {
  // Creator/refund shares, placements, uniform distribution, then no gating.
  for (const text of ["0", "0", "3", "3"]) await answer(text);
  if (!editing) await answer("1");
  assert.match(last(), /Reply 'create'/);
}
try {
  await begin();
  outage = true;
  await answer("1.5");
  assert.match(last(), /Couldn't read.*RPC unavailable/s);
  assert(isPending(chatId));
  assert.equal(submissions.length, 0);
  outage = false;
  await answer("1.5");
  assert.match(last(), /minimum 5%/);
  await answer("4.99");
  assert.match(last(), /Below the game's minimum/);
  await answer("skip");
  assert.match(last(), /Tournament creator cut/);
  await finishFee();

  // Revalidate at confirmation, preserve the wizard on outage, and allow retry.
  outage = true;
  await answer("create");
  assert.match(last(), /Nothing submitted.*retry/s);
  assert(isPending(chatId));
  assert.equal(submissions.length, 0);
  outage = false;
  fee = 600; // changed since the fee was selected
  await answer("create");
  assert.match(last(), /now requires at least 6%/);
  assert.equal(submissions.length, 0);
  await answer("7"); // above-floor overrides remain valid
  await finishFee(true);
  const held = pauseRead();
  const firstCreate = answer("create");
  await held.started;
  await answer("create"); // ignored while the first fee verification is pending
  held.release();
  await firstCreate;
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]![0]!.entrypoint, "create_tournament");

  // No recipient requires exactly zero, even with a nonzero fee numerator.
  recipient = "0x0";
  await begin();
  await answer("2");
  assert.match(last(), /no fee recipient.*0%/s);
  await answer("1");
  assert.match(last(), /Send 0/);
  await answer("skip");
  await finishFee();
  await answer("create");
  assert.equal(submissions.length, 2);

  // Changing the game from confirmation must read the newly selected token.
  recipient = "0x333";
  fee = 500;
  await begin();
  await answer("1");
  await answer("skip");
  await finishFee();
  await answer("edit 1");
  await answer("2");
  recipient = "0x0";
  await answer("create");
  assert.equal(reads.at(-1), "0x222");
  assert.match(last(), /no fee recipient.*Send 0/s);
  assert.equal(submissions.length, 2);

  // Cancelling while the final read is pending must not submit afterwards.
  await begin();
  await answer("1");
  await answer("skip");
  await finishFee();
  const cancelledRead = pauseRead();
  const cancelledCreate = answer("create");
  await cancelledRead.started;
  cancel(chatId);
  cancelledRead.release();
  await cancelledCreate;
  assert.equal(submissions.length, 2);
  assert.equal(isPending(chatId), false);

  // Free creation does not need a fee lookup, including during RPC outages.
  outage = true;
  const beforeFree = reads.length;
  await begin(false);
  await answer("1");
  await answer("create");
  assert.equal(reads.length, beforeFree);
  assert.equal(submissions.length, 3);
  console.log("Bot fee wizard checks passed: live terms, exact zero, overrides, retries, changed fees/games, and free creation");
} finally {
  cancel(chatId);
  RpcProvider.prototype.callContract = originalCall;
  globalThis.fetch = originalFetch;
}
