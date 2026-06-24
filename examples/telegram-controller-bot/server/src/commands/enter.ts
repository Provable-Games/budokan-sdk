// /enter [tournamentId]
//
// Two entry points:
//   - With an id: free → sessioned execute; paid → sessioned execute when the
//     fee token has an authorized spending limit and the fee fits under it,
//     else budokan.gg deeplink; gated → budokan.gg deeplink.
//   - Without an id: show a numbered picker of currently-enterable
//     tournaments on the user's active chain, let them pick, then run the
//     same logic with the resolved id.
//
// Picker filter: phases that actually accept new entries. For fixed
// tournaments that's Registration; for open tournaments it's Staging
// or Live (`has_registration` is false → those skip the Registration
// phase entirely). We don't filter out tournaments the user is already
// in — the contract handles the "already entered" case if relevant.
//
// Paid entries: /connect authorizes per-token spending limits (policies.ts +
// catalog/tokens.ts), so the bot can approve the exact fee + enter in one
// in-session multicall. Fees above the cap, or in tokens we didn't pre-approve,
// fall back to budokan.gg — Cartridge runs in a real browser there.

import { CHAINS, createBudokanClient, type Tournament } from "@provable-games/budokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import type { HandshakeStore } from "../handshake.ts";
import { TelegramApi } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { buildEnterTournamentCall, buildErc20ApproveCall } from "@provable-games/budokan-sdk";
import { gamesForChain } from "../catalog/games.ts";
import { findKnownToken } from "../catalog/tokens.ts";
import { formatError } from "../format-error.ts";
import { explorerTxUrl, tournamentPageUrl } from "@provable-games/budokan-sdk";
import { formatTimeUntil, formatTopPrizes } from "../format.ts";

type Step = "picker";

interface State {
  step: Step;
  chain: Chain;
  tournaments: Tournament[];      // snapshot at picker render time
  gameNames: Map<string, string>; // lowercase address → name
}

const states = new Map<string, State>();

export function isPending(chatId: string): boolean {
  return states.has(chatId);
}

export function cancel(chatId: string): boolean {
  return states.delete(chatId);
}

export async function start(
  api: TelegramApi,
  config: Config,
  handshakes: HandshakeStore,
  chatId: string,
  chain: Chain,
  args: string[],
): Promise<void> {
  // Explicit id: skip the picker. Validate the same way the old inline
  // handler did so the user gets the same error for bad input.
  if (args.length === 1 && args[0] && /^\d+$/.test(args[0])) {
    return execute(api, config, handshakes, chatId, chain, args[0]);
  }
  if (args.length !== 0) {
    await api.sendMessage(chatId, "Usage: /enter [tournamentId]\nWith no id I'll show a picker.");
    return;
  }

  // Picker path: fetch enterable tournaments + build display.
  const sdk = sdkClient(config, chain);
  const phasesToShow = ["registration", "staging", "live"] as const;
  let tournaments: Tournament[];
  try {
    // Fetch each phase, dedupe, sort by id desc (newest first).
    const results = await Promise.all(
      phasesToShow.map((phase) =>
        sdk
          .getTournaments({ phase, limit: 25, sort: "created_at", includePrizeSummary: true })
          .then((r) => r.data),
      ),
    );
    const byId = new Map<string, Tournament>();
    for (const list of results) {
      for (const t of list) byId.set(t.id, t);
    }
    tournaments = Array.from(byId.values()).sort((a, b) => Number(b.id) - Number(a.id));
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch tournaments: ${formatError(error)}`);
    return;
  }

  if (tournaments.length === 0) {
    await api.sendMessage(
      chatId,
      `🎯 No tournaments currently open on ${chain}.\nTry /tournaments to browse, or /create to make one.`,
    );
    return;
  }

  const gameNames = await buildGameNameMap(chain);
  states.set(chatId, { step: "picker", chain, tournaments, gameNames });

  const lines: string[] = [
    `🎮 Pick a tournament to enter on ${chain}:`,
    "",
  ];
  tournaments.forEach((t, i) => {
    const game = gameNames.get(t.gameAddress.toLowerCase()) ?? shortAddr(t.gameAddress);
    const feeIcon = extractFee(t) ? "💰" : "🆓";
    const feeLabel = extractFee(t) ? "paid" : "free";
    const entries = `👥 ${t.entryCount} ${t.entryCount === 1 ? "entry" : "entries"}`;
    const ends = formatTimeUntil(t.gameEndTime);
    const meta = [`${feeIcon} ${feeLabel}`, entries, ends].filter(Boolean).join(" · ");
    lines.push(`  ${i + 1}. 🎯 #${t.id} ${t.name || "(unnamed)"} — 🎮 ${game}`);
    lines.push(`     ${meta}`);
    const prizes = formatTopPrizes(t, chain);
    if (prizes) lines.push(`     🏆 ${prizes}`);
  });
  lines.push("");
  lines.push("Reply with a number, or send '/enter <id>' to enter a specific one. /cancel to abort.");
  await api.sendMessage(chatId, lines.join("\n"));
}

export async function handleAnswer(
  api: TelegramApi,
  config: Config,
  handshakes: HandshakeStore,
  chatId: string,
  text: string,
): Promise<void> {
  const state = states.get(chatId);
  if (!state) return;

  if (state.step !== "picker") return;

  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    await api.sendMessage(chatId, `Reply with a number 1–${state.tournaments.length}, or /cancel.`);
    return;
  }
  const n = Number(trimmed);
  if (n < 1 || n > state.tournaments.length) {
    await api.sendMessage(chatId, `Out of range. Pick 1–${state.tournaments.length}, or /cancel.`);
    return;
  }
  const chosen = state.tournaments[n - 1]!;
  states.delete(chatId);
  await execute(api, config, handshakes, chatId, state.chain, chosen.id);
}

// ----- core execution path: factored out of telegram.ts inline /enter -----

async function execute(
  api: TelegramApi,
  config: Config,
  handshakes: HandshakeStore,
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

  let tournament;
  try {
    tournament = await sdkClient(config, chain).getTournament(tournamentId);
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch tournament: ${formatError(error)}`);
    return;
  }
  if (!tournament) {
    await api.sendMessage(chatId, `Tournament ${tournamentId} not found.`);
    return;
  }

  const hasRequirement = !!tournament.entryRequirement || tournament.hasEntryRequirement === true;
  if (hasRequirement) {
    await api.sendMessage(
      chatId,
      [
        "This tournament has an entry requirement (NFT-gated or extension-gated).",
        "Building a qualification proof from chat input isn't supported here.",
        "",
        `Open: ${tournamentPageUrl(chain, tournamentId)}`,
      ].join("\n"),
    );
    return;
  }

  const enterCall = buildEnterTournamentCall(budokanAddress, {
    tournamentId,
    playerAddress: session.data.address,
  });

  // Two fields can describe the entry fee: the flat summary
  // (entryFeeAmount + entryFeeToken) and the structured entryFee JSONB
  // blob. For freshly-created tournaments the indexer often populates
  // the structured one first, with the flat summary catching up later.
  // Reading only the flat summary made the bot send a bare enter call
  // for a paid tournament — the contract's transferFrom then reverted
  // with "ERC20: insufficient allowance". Prefer structured; fall back
  // to the summary.
  const fee = extractFee(tournament);

  if (!fee) {
    await api.sendMessage(chatId, `⏳ Entering tournament #${tournamentId}…`);
    try {
      const tx = await session.data.account.execute([enterCall]);
      await api.sendMessage(
        chatId,
        [
          `✅ Entered tournament #${tournamentId}`,
          `🔗 ${explorerTxUrl(chain, tx.transaction_hash)}`,
          "",
          `📊 /leaderboard ${tournamentId}`,
        ].join("\n"),
      );
    } catch (error) {
      await api.sendMessage(chatId, `❌ Entry failed: ${formatError(error)}`);
    }
    return;
  }

  // Paid entry.
  const token = findKnownToken(chain, fee.token);
  const feeDisplay = token
    ? `${formatTokenAmount(fee.amount, token.decimals)} ${token.symbol}`
    : `${fee.amount} of ${shortAddr(fee.token)}`;

  // In-session path: if the fee token carries an authorized spending limit and
  // the fee fits under it, approve the exact fee + enter in one multicall — no
  // browser round-trip. The session was authorized for `approve` on this token
  // at /connect with a per-token cap (see policies.ts).
  if (token?.spendLimit && BigInt(fee.amount) <= BigInt(token.spendLimit)) {
    await api.sendMessage(chatId, `⏳ Entering #${tournamentId} — paying ${feeDisplay}…`);
    try {
      // Approve against the catalog's canonical token address (padded), which
      // is what the session spending-limit policy is keyed on — `fee.token`
      // comes from the indexer with leading zeros stripped, so using it could
      // miss the policy match.
      const approveCall = buildErc20ApproveCall(token.address, budokanAddress, fee.amount);
      const tx = await session.data.account.execute([approveCall, enterCall]);
      await api.sendMessage(
        chatId,
        [
          `✅ Entered tournament #${tournamentId} (paid ${feeDisplay})`,
          `🔗 ${explorerTxUrl(chain, tx.transaction_hash)}`,
          "",
          `📊 /leaderboard ${tournamentId}`,
        ].join("\n"),
      );
    } catch (error) {
      // Spending limit exhausted, session expired, or (older session) no approve
      // policy — fall back to budokan.gg.
      await api.sendMessage(
        chatId,
        [
          `Couldn't complete the in-chat entry: ${formatError(error)}`,
          "",
          "Finish it on budokan.gg instead:",
          `🔗 ${tournamentPageUrl(chain, tournamentId)}`,
        ].join("\n"),
      );
    }
    return;
  }

  // Unknown token, or a fee above the per-token session limit — sign on budokan.gg.
  await api.sendMessage(
    chatId,
    [
      `🎯 Tournament #${tournamentId} — ${tournament.name || "(unnamed)"}`,
      `💰 Entry fee: ${feeDisplay}`,
      "",
      token
        ? `This fee is above your in-chat ${token.symbol} spending limit — sign it on budokan.gg:`
        : "This fee token isn't pre-authorized for in-chat signing — sign it on budokan.gg:",
      "",
      `🔗 ${tournamentPageUrl(chain, tournamentId)}`,
    ].join("\n"),
  );
}

// ----- helpers -----

function sdkClient(config: Config, chain: Chain) {
  return createBudokanClient({
    chain,
    ...(config.apiUrl ? { apiBaseUrl: config.apiUrl } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.budokanAddress ? { budokanAddress: config.budokanAddress } : {}),
    ...(config.viewerAddress ? { viewerAddress: config.viewerAddress } : {}),
  } as Parameters<typeof createBudokanClient>[0]);
}

async function buildGameNameMap(chain: Chain): Promise<Map<string, string>> {
  const games = await gamesForChain(chain);
  const map = new Map<string, string>();
  for (const g of games) map.set(g.contractAddress.toLowerCase(), g.name);
  return map;
}

/**
 * Pull (token, amount) out of either the structured `entryFee` JSONB
 * blob or the flat `entryFeeAmount` / `entryFeeToken` summary fields.
 * Either can be populated alone for just-created tournaments — read
 * both and treat as paid if any source agrees on a positive amount.
 */
function extractFee(t: Tournament): { token: string; amount: string } | null {
  const structured = t.entryFee;
  if (structured?.tokenAddress && structured.amount && Number(structured.amount) > 0) {
    return { token: structured.tokenAddress, amount: structured.amount };
  }
  if (t.entryFeeToken && t.entryFeeAmount && Number(t.entryFeeAmount) > 0) {
    return { token: t.entryFeeToken, amount: t.entryFeeAmount };
  }
  return null;
}

function sessionErrorMessage(reason: "no_session" | "expired" | "policy_mismatch", chain: Chain): string {
  if (reason === "no_session") return `Not connected on ${chain} — run /connect first.`;
  if (reason === "expired") return `Your session on ${chain} expired. Run /connect to authorize again.`;
  return `Your session on ${chain} doesn't cover this action. Run /connect again.`;
}

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

/**
 * Format a raw u128/u256 amount string into a human-readable decimal
 * string with no trailing zeros. Duplicated from create.ts — should
 * move to a shared formatters module if a third caller appears.
 */
function formatTokenAmount(rawAmount: string, decimals: number): string {
  let bi: bigint;
  try {
    bi = BigInt(rawAmount);
  } catch {
    return rawAmount;
  }
  if (decimals === 0) return bi.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = (bi / divisor).toString();
  const frac = (bi % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

