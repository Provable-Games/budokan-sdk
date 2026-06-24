// /distribute <id> — claim every unclaimed reward in a tournament's pool.
//
// Where /claim is scoped to the connected wallet's own placements, this is the
// admin "settle the whole tournament" button: it fires the permissionless
// claims for every position payout, the tournament-creator / game-creator /
// protocol-fee shares, and every sponsored prize. The contract routes each
// payout to its rightful recipient (winner, creator, DAO treasury, sponsor) —
// the caller just pays gas to trigger them.
//
// Per-token entry-fee refunds are intentionally NOT included: they're one claim
// per entrant (potentially hundreds) and are better claimed per-wallet via
// /claim. getDistributableRewards only enumerates refunds when given the
// entrant token list, which we don't pass here.
//
// Large pools are split into batches so no single multicall blows past the
// per-tx call limit or the paymaster's sponsorship bounds.

import {
  CHAINS,
  buildClaimCalls,
  createBudokanClient,
  getDistributableRewards,
} from "@provable-games/budokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import { TelegramApi } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { formatError } from "../format-error.ts";
import { explorerTxUrl } from "../links.ts";

const BATCH_SIZE = 25;

export async function distribute(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
  args: string[],
): Promise<void> {
  const tournamentId = args[0];
  if (!tournamentId || !/^\d+$/.test(tournamentId)) {
    await api.sendMessage(
      chatId,
      [
        "Usage: /distribute <tournamentId>",
        "Claims every unclaimed reward in the pool — position payouts, the",
        "creator/game/protocol-fee shares, and sponsored prizes. Permissionless:",
        "each payout still goes to its rightful recipient. (Per-entrant refunds",
        "aren't included — claim those per wallet with /claim.)",
      ].join("\n"),
    );
    return;
  }

  const session = await resolveAccount(chatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(chatId, sessionErrorMessage(session.reason, chain));
    return;
  }

  const budokanAddress = config.budokanAddress ?? CHAINS[chain]?.budokanAddress;
  if (!budokanAddress) {
    await api.sendMessage(chatId, `Internal error: no Budokan address for ${chain}.`);
    return;
  }

  const client = sdkClient(config, chain);
  let tournament, prizes, claims;
  try {
    [tournament, prizes, claims] = await Promise.all([
      client.getTournament(tournamentId),
      client.getTournamentPrizes(tournamentId),
      client.getTournamentRewardClaims(tournamentId, { limit: 1000 }),
    ]);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't load tournament data: ${formatError(error)}`);
    return;
  }
  if (!tournament) {
    await api.sendMessage(chatId, `Tournament ${tournamentId} not found on ${chain}.`);
    return;
  }

  const rewards = getDistributableRewards({
    tournament,
    prizes,
    existingClaims: claims.data,
  });
  if (rewards.length === 0) {
    await api.sendMessage(chatId, `Nothing left to distribute for #${tournamentId}.`);
    return;
  }

  const calls = buildClaimCalls(rewards, budokanAddress);
  const batches = chunk(calls, BATCH_SIZE);
  const noun = rewards.length === 1 ? "reward" : "rewards";
  await api.sendMessage(
    chatId,
    `Distributing ${rewards.length} ${noun} for #${tournamentId}` +
      (batches.length > 1 ? ` in ${batches.length} batches…` : "…"),
  );

  const account = session.data.account;
  const hashes: string[] = [];
  let done = 0;
  for (const [i, batch] of batches.entries()) {
    try {
      const tx = await account.execute(batch);
      hashes.push(tx.transaction_hash);
      done += batch.length;
      // Wait for acceptance before the next batch so the nonce doesn't race.
      if (account.waitForTransaction && i < batches.length - 1) {
        await account.waitForTransaction(tx.transaction_hash);
      }
      if (batches.length > 1) {
        await api.sendMessage(chatId, `Batch ${i + 1}/${batches.length} ✓ (${done}/${rewards.length})`);
      }
    } catch (error) {
      await api.sendMessage(
        chatId,
        `❌ Stopped after ${done}/${rewards.length}: ${formatError(error)}`,
      );
      return;
    }
  }

  await api.sendMessage(
    chatId,
    [
      `✅ Distributed ${rewards.length} ${noun} for #${tournamentId}`,
      ...hashes.map((h) => `🔗 ${explorerTxUrl(chain, h)}`),
    ].join("\n"),
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sdkClient(config: Config, chain: Chain) {
  return createBudokanClient({
    chain,
    ...(config.apiUrl ? { apiBaseUrl: config.apiUrl } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.budokanAddress ? { budokanAddress: config.budokanAddress } : {}),
    ...(config.viewerAddress ? { viewerAddress: config.viewerAddress } : {}),
  } as Parameters<typeof createBudokanClient>[0]);
}

function sessionErrorMessage(
  reason: "no_session" | "expired" | "policy_mismatch",
  chain: Chain,
): string {
  if (reason === "no_session") return `Not connected on ${chain} — run /connect first.`;
  if (reason === "expired") return `Your session on ${chain} expired. Run /connect to authorize again.`;
  return `Your session on ${chain} doesn't cover this action. Run /connect again.`;
}
