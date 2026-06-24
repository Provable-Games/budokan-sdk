// /claim <id>  (no reward kind) — claim everything the connected wallet can.
//
// The low-level `/claim <id> <kind> ...` path in telegram.ts lets a power user
// name a specific RewardType. This is the friendly version: figure out what the
// connected wallet is owed for a tournament and fire one multicall.
//
// How "what am I owed" is resolved, all from public SDK + denshokan reads:
//   1. denshokan getTokens(minterAddress=budokan, contextId=tournamentId) → the
//      tournament's entered game tokens, each with an `owner`. Keep the ones
//      this wallet owns.
//   2. the on-chain leaderboard (viewer) maps token → finishing position. The
//      wallet's owned-and-placed tokens become PlayerPlacements.
//   3. getClaimableRewards turns placements + prizes + existing claims into the
//      not-yet-claimed, non-zero rewards; buildClaimCalls encodes them.
//
// Entry into this lives in telegram.ts `claim()`, which routes a bare id here.

import {
  CHAINS,
  buildClaimCalls,
  createBudokanClient,
  getClaimableRewards,
  normalizeAddress,
  type PlayerPlacement,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient, type Token } from "@provable-games/denshokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import { TelegramApi } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { formatError } from "../format-error.ts";
import { explorerTxUrl } from "../links.ts";

export async function claimAll(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
  tournamentId: string,
): Promise<void> {
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
  let tournament, prizes, leaderboard, claims;
  try {
    [tournament, prizes, leaderboard, claims] = await Promise.all([
      client.getTournament(tournamentId),
      client.getTournamentPrizes(tournamentId),
      client.getTournamentLeaderboard(tournamentId),
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

  // Which of this tournament's entered tokens does the connected wallet own?
  const denshokan = createDenshokanClient({ chain });
  let tokens: Token[];
  try {
    const res = await denshokan.getTokens({
      minterAddress: normalizeAddress(budokanAddress),
      contextId: Number(tournamentId),
      limit: 500,
    });
    tokens = res.data;
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't resolve your entries: ${formatError(error)}`);
    return;
  }
  const me = normalizeAddress(session.data.address);
  const myTokenIds = new Set(
    tokens
      .filter((t) => t.owner && normalizeAddress(t.owner) === me)
      .map((t) => idKey(t.tokenId)),
  );
  if (myTokenIds.size === 0) {
    await api.sendMessage(chatId, `No entries owned by your wallet in tournament #${tournamentId}.`);
    return;
  }

  // Placements = leaderboard entries for the wallet's owned tokens. A token
  // that hasn't had a score submitted on-chain won't appear here (and has no
  // position prize to claim yet).
  const placements: PlayerPlacement[] = leaderboard
    .filter((e) => myTokenIds.has(idKey(e.tokenId)))
    .map((e) => ({ tournamentId, tokenId: e.tokenId, position: e.position, score: "0" }));

  const rewards = getClaimableRewards({
    placements,
    tournaments: [tournament],
    prizes,
    existingClaims: claims.data,
  });

  if (rewards.length === 0) {
    await api.sendMessage(
      chatId,
      placements.length === 0
        ? `Your entries aren't on the leaderboard for #${tournamentId} yet — nothing to claim.`
        : `Nothing left to claim for #${tournamentId} (already claimed, or zero-value).`,
    );
    return;
  }

  const calls = buildClaimCalls(rewards, budokanAddress);
  const noun = rewards.length === 1 ? "reward" : "rewards";
  await api.sendMessage(chatId, `Claiming ${rewards.length} ${noun} for #${tournamentId}…`);
  try {
    const tx = await session.data.account.execute(calls);
    await api.sendMessage(
      chatId,
      [
        `✅ Claimed ${rewards.length} ${noun} for #${tournamentId}`,
        `🔗 ${explorerTxUrl(chain, tx.transaction_hash)}`,
      ].join("\n"),
    );
  } catch (error) {
    await api.sendMessage(chatId, `❌ Claim failed: ${formatError(error)}`);
  }
}

// Token ids arrive as hex (viewer) or decimal (denshokan); compare by value.
function idKey(tokenId: string): string {
  try {
    return BigInt(tokenId).toString();
  } catch {
    return String(tokenId);
  }
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
