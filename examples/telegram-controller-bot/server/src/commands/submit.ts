// /submit_score [tournamentId]
//
// Submitting a score finalizes it onto the on-chain leaderboard. Players (or
// anyone) submit the top scores in rank order; a token's `position` is its
// 1-indexed rank by score among the tournament's game-over tokens, capped to
// the number of paid prize positions. The raw entrypoint needs
// (tournamentId, tokenId, position) — impossible to know by hand — so this
// flow computes everything and offers "submit one" or "submit all in order".
//
// Position logic mirrors the Budokan web client's getSubmittableScores; it now
// also lives in the SDK (budokan-sdk `getSubmittableScores`). Inlined here as
// `submittableScores` until the bot bumps to the SDK release that ships it.

import {
  CHAINS,
  createBudokanClient,
  buildSubmitScoreCall,
  type Tournament,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient } from "@provable-games/denshokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import { TelegramApi } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { formatError } from "../format-error.ts";
import { rankPrefix } from "../format.ts";

interface RankedToken {
  tokenId: string;
  score: number;
  position: number; // 1-indexed rank
  submitted: boolean;
  mine: boolean;
}

interface State {
  step: "pickTournament" | "pickScore";
  chain: Chain;
  // pickTournament:
  tournaments?: Tournament[];
  // pickScore:
  tournamentId?: string;
  tournamentName?: string;
  ranked?: RankedToken[];
}

const states = new Map<string, State>();

export function isPending(chatId: string): boolean {
  return states.has(chatId);
}

export function cancel(chatId: string): boolean {
  return states.delete(chatId);
}

// ----- entrypoint -----

export async function start(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
  args: string[],
): Promise<void> {
  if (args.length === 1 && args[0] && /^\d+$/.test(args[0])) {
    return showScores(api, config, chatId, chain, args[0]);
  }
  if (args.length !== 0) {
    await api.sendMessage(chatId, "Usage: /submit_score [tournamentId]\nWith no id I'll show the tournaments you've entered.");
    return;
  }

  // Picker: tournaments the user has entered (needs a session to know who).
  const session = await resolveAccount(chatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(chatId, sessionErrorMessage(session.reason, chain));
    return;
  }

  let tournamentIds: string[];
  try {
    tournamentIds = await ownedTournamentIds(chain, session.data.address);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't read your entries: ${formatError(error)}`);
    return;
  }
  if (tournamentIds.length === 0) {
    await api.sendMessage(chatId, `You haven't entered any tournaments on ${chain}. Run /enter first.`);
    return;
  }

  let tournaments: Tournament[];
  try {
    const res = await sdk(config, chain).getTournaments({
      tournamentIds,
      limit: tournamentIds.length,
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

  states.set(chatId, { step: "pickTournament", chain, tournaments });
  const lines = [`🏅 Submit scores — pick a tournament on ${chain}:`, ""];
  tournaments.forEach((t, i) => {
    lines.push(`  ${i + 1}. 🎯 #${t.id} ${t.name || "(unnamed)"}`);
  });
  lines.push("", "Reply with a number, or send '/submit_score <id>'. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

export async function handleAnswer(
  api: TelegramApi,
  config: Config,
  chatId: string,
  text: string,
): Promise<void> {
  const state = states.get(chatId);
  if (!state) return;
  const trimmed = text.trim().toLowerCase();

  if (state.step === "pickTournament") {
    if (!/^\d+$/.test(trimmed)) {
      await api.sendMessage(chatId, `Reply with a number 1–${state.tournaments!.length}, or /cancel.`);
      return;
    }
    const n = Number(trimmed);
    if (n < 1 || n > state.tournaments!.length) {
      await api.sendMessage(chatId, `Out of range. Pick 1–${state.tournaments!.length}, or /cancel.`);
      return;
    }
    const chosen = state.tournaments![n - 1]!;
    states.delete(chatId);
    return showScores(api, config, chatId, state.chain, chosen.id);
  }

  // step === "pickScore"
  const ranked = state.ranked ?? [];
  const tournamentId = state.tournamentId!;
  const chain = state.chain;
  const submittable = ranked.filter((r) => !r.submitted);
  // The connected wallet's own unsubmitted prize-position scores.
  const mine = submittable.filter((r) => r.mine);

  if (trimmed === "all") {
    states.delete(chatId);
    return submitMany(api, config, chatId, chain, tournamentId, submittable);
  }
  if (trimmed === "mine") {
    if (mine.length === 0) {
      await api.sendMessage(
        chatId,
        "You don't have any unsubmitted prize-position scores. Reply 'all' to submit everyone's, a position number, or /cancel.",
      );
      return;
    }
    states.delete(chatId);
    // submitMany sorts by position and submits in one execute; its failure
    // hint already covers the case where a higher position is still missing.
    return submitMany(api, config, chatId, chain, tournamentId, mine);
  }
  if (/^\d+$/.test(trimmed)) {
    const pos = Number(trimmed);
    const target = submittable.find((r) => r.position === pos);
    if (!target) {
      await api.sendMessage(
        chatId,
        `Position ${pos} isn't an unsubmitted entry. Reply one of: ${submittable.map((r) => r.position).join(", ") || "(none)"}, or 'all'.`,
      );
      return;
    }
    states.delete(chatId);
    return submitMany(api, config, chatId, chain, tournamentId, [target]);
  }
  await api.sendMessage(
    chatId,
    mine.length > 0
      ? "Reply 'mine', 'all', a position number, or /cancel."
      : "Reply a position number, 'all', or /cancel.",
  );
}

// ----- core -----

async function showScores(
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

  const client = sdk(config, chain);
  let tournament: Tournament | null;
  try {
    tournament = await client.getTournament(tournamentId);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't load tournament: ${formatError(error)}`);
    return;
  }
  if (!tournament) {
    await api.sendMessage(chatId, `Tournament ${tournamentId} not found.`);
    return;
  }

  // Leaderboard size = highest paid prize position (sponsored + entry-fee),
  // matching the web client. Default to 3 when there are no positioned prizes.
  let prizePositions = 3;
  try {
    const prizes = await client.getTournamentPrizes(tournamentId);
    const max = prizes.reduce((m, p) => Math.max(m, p.payoutPosition ?? 0), 0);
    if (max > 0) prizePositions = max;
  } catch {
    // keep default
  }

  // Ascending leaderboards rank lowest-score-first; mirror that in the sort.
  const ascending = tournament.leaderboardConfig?.ascending === true;

  // Entries come from the tournament's REGISTRATIONS — the authoritative list
  // of tokens actually entered in this tournament, with each token's submitted
  // status. (A denshokan `contextId` query is NOT safe here: contextId is a
  // generic per-game field, so `contextId == 1` collides with context #1 of
  // other games and would surface tokens that never entered this tournament.)
  let entries: { tokenId: string; hasSubmitted: boolean }[];
  try {
    const res = await client.getTournamentRegistrations(tournamentId, { isBanned: false, limit: 500 });
    entries = res.data
      .filter((r) => !r.isBanned)
      .map((r) => ({ tokenId: r.gameTokenId, hasSubmitted: r.hasSubmitted }));
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't read entries: ${formatError(error)}`);
    return;
  }
  if (entries.length === 0) {
    await api.sendMessage(
      chatId,
      `🏅 No entries yet for #${tournamentId} ${tournament.name ? `"${tournament.name}"` : ""}.`,
    );
    return;
  }

  // Scores for the entered tokens (denshokan), and which tokens are the user's.
  // Both are best-effort: a scores/ownership read failure shouldn't blank the
  // whole view — we still show entries (with unknown scores) and submit status.
  const denshokan = createDenshokanClient({ chain });
  const scoreById = new Map<string, number>();
  let mine = new Set<string>();

  try {
    // Scope the rank query to this tournament's context — the ranks endpoint
    // 500s on an empty scope, and the explicit token-id list keeps it bounded.
    const ranks = await denshokan.getTokenRanks(entries.map((e) => e.tokenId), {
      contextId: Number(tournamentId),
    });
    for (const r of ranks.data) scoreById.set(tokenKey(r.tokenId), r.score);
  } catch (error) {
    console.error("submit: getTokenRanks failed:", formatError(error));
  }

  try {
    const ours = await denshokan.getPlayerTokens(session.data.address, { limit: 200 });
    mine = new Set(
      ours.data
        .filter((t) => t.contextId !== null && Number(t.contextId) === Number(tournamentId))
        .map((t) => tokenKey(t.tokenId)),
    );
  } catch (error) {
    console.error("submit: getPlayerTokens failed:", formatError(error));
  }

  // Sort by score (direction per leaderboard), assign 1-indexed rank positions,
  // and cap to the paid prize positions.
  const ranked: RankedToken[] = entries
    .map((e) => ({
      tokenId: e.tokenId,
      score: scoreById.get(tokenKey(e.tokenId)) ?? 0,
      submitted: e.hasSubmitted,
      mine: mine.has(tokenKey(e.tokenId)),
      position: 0,
    }))
    .sort((a, b) => (ascending ? a.score - b.score : b.score - a.score))
    .slice(0, prizePositions)
    .map((r, i) => ({ ...r, position: i + 1 }));

  const unsubmitted = ranked.filter((r) => !r.submitted);

  const lines = [
    `🏅 #${tournamentId} ${tournament.name ? `"${tournament.name}"` : ""} — top ${prizePositions} prize positions:`,
    "",
  ];
  for (const r of ranked) {
    const who = r.mine ? "👤 you" : `🎮 ${shortId(r.tokenId)}`;
    const status = r.submitted ? "✅ submitted" : "⬜ not submitted";
    lines.push(`  ${rankPrefix(r.position)} score ${r.score} · ${who} · ${status}`);
  }
  lines.push("");
  if (unsubmitted.length === 0) {
    states.delete(chatId);
    lines.push("All prize-position scores are already submitted. 🎉");
    await api.sendMessage(chatId, lines.join("\n"));
    return;
  }
  // Distinguish "submit just mine" from "submit everyone's" when the connected
  // wallet has its own unsubmitted prize-position scores.
  const minePositions = unsubmitted.filter((r) => r.mine).map((r) => r.position);
  if (minePositions.length > 0) {
    lines.push(
      `👤 You're in position${minePositions.length === 1 ? "" : "s"} ${minePositions.join(", ")}.`,
      `Reply 'mine' to submit just your score${minePositions.length === 1 ? "" : "s"}, 'all' to submit everyone's ${unsubmitted.length} unsubmitted score${unsubmitted.length === 1 ? "" : "s"} in order,`,
      `or a position number (${unsubmitted.map((r) => r.position).join(", ")}) to submit just that one. /cancel to abort.`,
    );
  } else {
    lines.push(
      `Reply 'all' to submit the ${unsubmitted.length} unsubmitted score${unsubmitted.length === 1 ? "" : "s"} in order,`,
      `or a position number (${unsubmitted.map((r) => r.position).join(", ")}) to submit just that one. /cancel to abort.`,
    );
  }

  states.set(chatId, {
    step: "pickScore",
    chain,
    tournamentId,
    tournamentName: tournament.name ?? "",
    ranked,
  });
  await api.sendMessage(chatId, lines.join("\n"));
}

async function submitMany(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
  tournamentId: string,
  entries: RankedToken[],
): Promise<void> {
  if (entries.length === 0) {
    await api.sendMessage(chatId, "Nothing to submit.");
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

  // Submit in rank order so the on-chain leaderboard fills without gaps.
  const ordered = [...entries].sort((a, b) => a.position - b.position);
  const calls = ordered.map((e) =>
    buildSubmitScoreCall(budokanAddress, {
      tournamentId,
      tokenId: e.tokenId,
      position: e.position,
    }),
  );

  await api.sendMessage(
    chatId,
    `⏳ Submitting ${ordered.length} score${ordered.length === 1 ? "" : "s"} for #${tournamentId} (position${ordered.length === 1 ? "" : "s"} ${ordered.map((e) => e.position).join(", ")})…`,
  );
  try {
    const tx = await session.data.account.execute(calls);
    await api.sendMessage(
      chatId,
      [
        `✅ Submitted ${ordered.length} score${ordered.length === 1 ? "" : "s"} for #${tournamentId}`,
        `🔗 tx ${tx.transaction_hash}`,
        "",
        `📊 /leaderboard ${tournamentId}`,
      ].join("\n"),
    );
  } catch (error) {
    await api.sendMessage(
      chatId,
      [
        `❌ Submission failed: ${formatError(error)}`,
        "",
        "If you submitted a single mid-ranked score, the positions above it must be submitted first — try 'all' via /submit_score instead.",
      ].join("\n"),
    );
  }
}

// ----- helpers -----

function sdk(config: Config, chain: Chain) {
  return createBudokanClient({
    chain,
    ...(config.apiUrl ? { apiBaseUrl: config.apiUrl } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.budokanAddress ? { budokanAddress: config.budokanAddress } : {}),
    ...(config.viewerAddress ? { viewerAddress: config.viewerAddress } : {}),
  } as Parameters<typeof createBudokanClient>[0]);
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

function tokenKey(id: string): string {
  try {
    return BigInt(id).toString();
  } catch {
    return id;
  }
}

function shortId(id: string): string {
  if (!id || id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function sessionErrorMessage(reason: "no_session" | "expired" | "policy_mismatch", chain: Chain): string {
  if (reason === "no_session") return `Not connected on ${chain} — run /connect first.`;
  if (reason === "expired") return `Your session on ${chain} expired. Run /connect to authorize again.`;
  return `Your session on ${chain} doesn't cover this action. Run /connect again.`;
}
