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
  type Prize,
  type Tournament,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient, type Token } from "@provable-games/denshokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import { TelegramApi } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { fetchAllRewardClaims } from "../reward-claims.ts";
import { executeBatched, DEFAULT_BATCH_SIZE } from "../execute-batched.ts";
import { formatError } from "../format-error.ts";
import { explorerTxUrl } from "@provable-games/budokan-sdk";
import { distribute } from "./distribute.ts";
import { findKnownToken } from "../catalog/tokens.ts";
import { formatTokenAmount, rankPrefix } from "../format.ts";

// ----- interactive /claim flow: prize overview + "mine" vs "all" -----
//
// A bare /claim (or /claim <id>) is the friendly path: pick a tournament, see
// the prizes up for grabs, then choose to claim what YOUR wallet is owed
// ('mine' → claimAll) or settle the whole pool for everyone ('all' →
// distribute, permissionless). The /claim <id> <kind> form in telegram.ts
// stays for power users.

interface ClaimFlowState {
  step: "pickTournament" | "pickAction";
  chain: Chain;
  tournaments?: Tournament[];
  tournamentId?: string;
}

const claimFlows = new Map<string, ClaimFlowState>();

export function isPending(chatId: string): boolean {
  return claimFlows.has(chatId);
}

export function cancel(chatId: string): boolean {
  return claimFlows.delete(chatId);
}

/** /claim with no id — pick from the tournaments the wallet has entered. */
export async function startPicker(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
): Promise<void> {
  const session = await resolveAccount(chatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(chatId, sessionErrorMessage(session.reason, chain));
    return;
  }

  let ids: string[];
  try {
    ids = await ownedTournamentIds(chain, session.data.address);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't read your entries: ${formatError(error)}`);
    return;
  }
  if (ids.length === 0) {
    await api.sendMessage(chatId, `You haven't entered any tournaments on ${chain}. Run /enter first.`);
    return;
  }

  let tournaments: Tournament[];
  try {
    const res = await sdkClient(config, chain).getTournaments({
      tournamentIds: ids,
      limit: ids.length,
      sort: "created_at",
    });
    tournaments = res.data.sort((a, b) => Number(b.id) - Number(a.id));
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't load your tournaments: ${formatError(error)}`);
    return;
  }
  if (tournaments.length === 0) {
    await api.sendMessage(chatId, `Couldn't resolve your entered tournaments on ${chain}.`);
    return;
  }

  claimFlows.set(chatId, { step: "pickTournament", chain, tournaments });
  const lines = [`🏆 Claim rewards — pick a tournament on ${chain}:`, ""];
  tournaments.forEach((t, i) => {
    lines.push(`  ${i + 1}. 🎯 #${t.id} ${t.name || "(unnamed)"}`);
  });
  lines.push("", "Reply with a number, or send '/claim <id>'. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

/** Show the prizes up for grabs for one tournament, then offer mine/all. */
export async function showClaimView(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
  tournamentId: string,
): Promise<void> {
  const client = sdkClient(config, chain);
  let tournament: Tournament | null;
  let prizes: Prize[];
  try {
    [tournament, prizes] = await Promise.all([
      client.getTournament(tournamentId),
      client.getTournamentPrizes(tournamentId),
    ]);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't load tournament data: ${formatError(error)}`);
    return;
  }
  if (!tournament) {
    await api.sendMessage(chatId, `Tournament ${tournamentId} not found on ${chain}.`);
    return;
  }

  const lines = [`🏆 #${tournamentId} ${tournament.name ? `"${tournament.name}"` : ""} — prizes up for grabs:`, ""];

  // Sponsored prizes grouped by paid position.
  const byPosition = new Map<number, Prize[]>();
  for (const p of prizes) {
    const pos = p.payoutPosition ?? 0;
    if (!byPosition.has(pos)) byPosition.set(pos, []);
    byPosition.get(pos)!.push(p);
  }
  const positions = [...byPosition.keys()].sort((a, b) => a - b);
  if (positions.length > 0) {
    for (const pos of positions) {
      const label = pos > 0 ? rankPrefix(pos) : "🎁";
      const parts = byPosition.get(pos)!.map((p) => formatPrize(p, chain));
      lines.push(`  ${label} ${parts.join(", ")}`);
    }
  } else {
    lines.push("  (No sponsored prizes posted.)");
  }

  // Entry-fee pool + creator shares are also paid out by 'all'.
  if (tournament.entryFee?.tokenAddress) {
    lines.push("", "💰 Plus the entry-fee pool (per-position payouts, refunds, creator shares).");
  }

  lines.push(
    "",
    "Reply 'mine' to claim what your wallet is owed,",
    "or 'all' to pay out every unclaimed reward to all winners (permissionless). /cancel to abort.",
  );

  claimFlows.set(chatId, { step: "pickAction", chain, tournamentId });
  await api.sendMessage(chatId, lines.join("\n"));
}

export async function handleAnswer(
  api: TelegramApi,
  config: Config,
  chatId: string,
  text: string,
): Promise<void> {
  const state = claimFlows.get(chatId);
  if (!state) return;
  const trimmed = text.trim().toLowerCase();

  if (state.step === "pickTournament") {
    const list = state.tournaments ?? [];
    if (!/^\d+$/.test(trimmed)) {
      await api.sendMessage(chatId, `Reply with a number 1–${list.length}, or /cancel.`);
      return;
    }
    const n = Number(trimmed);
    if (n < 1 || n > list.length) {
      await api.sendMessage(chatId, `Out of range. Pick 1–${list.length}, or /cancel.`);
      return;
    }
    const chosen = list[n - 1]!;
    claimFlows.delete(chatId);
    return showClaimView(api, config, chatId, state.chain, chosen.id);
  }

  // step === "pickAction"
  const tournamentId = state.tournamentId!;
  const chain = state.chain;
  if (trimmed === "mine") {
    claimFlows.delete(chatId);
    return claimAll(api, config, chatId, chain, tournamentId);
  }
  if (trimmed === "all") {
    claimFlows.delete(chatId);
    return distribute(api, config, chatId, chain, [tournamentId]);
  }
  await api.sendMessage(chatId, "Reply 'mine', 'all', or /cancel.");
}

/** A short, human description of a single sponsored prize. */
function formatPrize(p: Prize, chain: Chain): string {
  if (p.tokenType === "erc721") {
    return p.tokenId ? `NFT #${p.tokenId}` : "NFT";
  }
  if (p.tokenType === "extension") {
    return "extension prize";
  }
  // erc20
  const token = p.tokenAddress ? findKnownToken(chain, p.tokenAddress) : undefined;
  if (token && p.amount) {
    return `${formatTokenAmount(p.amount, token.decimals)} ${token.symbol}`;
  }
  return p.amount ? `${p.amount} (raw)` : "prize";
}

async function ownedTournamentIds(chain: Chain, address: string): Promise<string[]> {
  const denshokan = createDenshokanClient({ chain });
  const res = await denshokan.getPlayerTokens(address, { limit: 200 });
  const ids = new Set<string>();
  for (const token of res.data) {
    if (token.hasContext && token.contextId !== null) ids.add(String(token.contextId));
  }
  return Array.from(ids);
}

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
      fetchAllRewardClaims(client, tournamentId),
    ]);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't load tournament data: ${formatError(error)}`);
    return;
  }
  if (!tournament) {
    await api.sendMessage(chatId, `Tournament ${tournamentId} not found on ${chain}.`);
    return;
  }

  // denshokan's contextId is a JS number; reject ids that would lose precision
  // (u64 ids are small in practice, so this is just a guard).
  if (!Number.isSafeInteger(Number(tournamentId))) {
    await api.sendMessage(chatId, `Tournament #${tournamentId} id is out of range for an in-chat lookup.`);
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
    existingClaims: claims,
  });

  // getClaimableRewards is placement-scoped and excludes per-token entry-fee
  // refunds. Add the wallet's own unclaimed refunds (each owned token gets
  // refundShare% of one entry fee back) so a bare /claim doesn't miss them.
  const ef = tournament.entryFee;
  const refundBps = Number(ef?.refundShare ?? 0);
  if (ef?.tokenAddress && refundBps > 0) {
    const perToken = (BigInt(ef.amount ?? "0") * BigInt(refundBps)) / 10000n;
    if (perToken > 0n) {
      const claimedRefunds = new Set(
        claims
          .filter((c) => c.claimed && c.claimKind === "entry_fee_refund" && c.refundTokenId != null)
          .map((c) => idKey(c.refundTokenId!)),
      );
      for (const tokenId of myTokenIds) {
        if (claimedRefunds.has(tokenId)) continue;
        rewards.push({
          tournamentId,
          tournamentName: tournament.name || `#${tournamentId}`,
          source: "entry_fee_refund",
          position: 0,
          tokenAddress: ef.tokenAddress,
          tokenType: "erc20",
          amount: perToken,
          tokenId,
          reward: { kind: "entry_fee_refund", tokenId },
        });
      }
    }
  }

  if (rewards.length === 0) {
    await api.sendMessage(
      chatId,
      placements.length === 0
        ? `Your entries aren't on the leaderboard for #${tournamentId} yet — nothing to claim.`
        : `Nothing left to claim for #${tournamentId} (already claimed, or zero-value).`,
    );
    return;
  }

  // Batched like /distribute: a wallet with many rewards can otherwise exceed
  // the per-tx call limit / paymaster bounds.
  const calls = buildClaimCalls(rewards, budokanAddress);
  const noun = rewards.length === 1 ? "reward" : "rewards";
  await api.sendMessage(
    chatId,
    `Claiming ${rewards.length} ${noun} for #${tournamentId}` +
      (calls.length > DEFAULT_BATCH_SIZE ? " in batches…" : "…"),
  );

  const { hashes, done, error } = await executeBatched(
    session.data.account,
    calls,
    DEFAULT_BATCH_SIZE,
    (p) => {
      if (p.total > 1) api.sendMessage(chatId, `Batch ${p.index}/${p.total} ✓ (${p.done}/${rewards.length})`);
    },
  );
  if (error) {
    await api.sendMessage(chatId, `❌ Stopped after ${done}/${rewards.length}: ${formatError(error)}`);
    return;
  }
  await api.sendMessage(
    chatId,
    [
      `✅ Claimed ${rewards.length} ${noun} for #${tournamentId}`,
      ...hashes.map((h) => `🔗 ${explorerTxUrl(chain, h)}`),
    ].join("\n"),
  );
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
