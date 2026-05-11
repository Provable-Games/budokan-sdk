// /enter [tournamentId]
//
// Two entry points:
//   - With an id: jump straight to the existing branching logic (free →
//     sessioned execute; paid → Mini App tx flow; gated → deeplink).
//   - Without an id: show a numbered picker of currently-enterable
//     tournaments on the user's active chain, let them pick, then run the
//     same logic with the resolved id.
//
// Picker filter: phases that actually accept new entries. For fixed
// tournaments that's Registration; for open tournaments it's Staging
// or Live (`has_registration` is false → those skip the Registration
// phase entirely). We don't filter out tournaments the user is already
// in — the contract handles the "already entered" case if relevant.

import { CHAINS, createBudokanClient, type Tournament } from "@provable-games/budokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import type { HandshakeStore } from "../handshake.ts";
import { TelegramApi, webAppButton } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import {
  buildEnterTournamentCall,
  buildErc20ApproveCall,
  type Call,
} from "../budokan-calls.ts";
import { gamesForChain } from "../catalog/games.ts";
import { formatError } from "../format-error.ts";
import { tournamentPageUrl } from "../links.ts";

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
        sdk.getTournaments({ phase, limit: 25, sort: "created_at" }).then((r) => r.data),
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
      `No tournaments currently open on ${chain}. Try /tournaments to browse, or /create to make one.`,
    );
    return;
  }

  const gameNames = await buildGameNameMap(chain);
  states.set(chatId, { step: "picker", chain, tournaments, gameNames });

  const lines = [
    `Pick a tournament to enter on ${chain}:`,
    "",
    ...tournaments.map((t, i) => `  ${i + 1}. ${formatPickerLine(t, gameNames)}`),
    "",
    "Reply with a number, or send '/enter <id>' to enter a specific one. /cancel to abort.",
  ];
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
    await api.sendMessage(chatId, `Entering tournament ${tournamentId}…`);
    try {
      const tx = await session.data.account.execute([enterCall]);
      await api.sendMessage(chatId, `Entered ✓\ntx: ${tx.transaction_hash}`);
    } catch (error) {
      await api.sendMessage(chatId, `Entry failed: ${formatError(error)}`);
    }
    return;
  }

  // Paid entry — route through Mini App tx flow.
  const calls: Call[] = [
    buildErc20ApproveCall(fee.token, budokanAddress, fee.amount),
    enterCall,
  ];
  const summary = [
    `Tournament ${tournamentId} — ${tournament.name || "(unnamed)"}`,
    `Entry fee: ${fee.amount} of ${shortAddr(fee.token)}`,
    "",
    `Calls (${calls.length}):`,
    `  1. approve(${shortAddr(budokanAddress)}, ${fee.amount}) on token ${shortAddr(fee.token)}`,
    `  2. enter_tournament(${tournamentId}, ...)`,
  ].join("\n");

  const handshake = handshakes.mint(chatId, "tx", chain, { payload: { calls, summary } });
  const url = `${config.miniAppUrl}/?token=${encodeURIComponent(handshake.token)}&mode=tx`;
  await api.sendMessage(
    chatId,
    [
      "This tournament has an entry fee.",
      "Tap the button below — the Mini App will open and Cartridge will ask you to approve and submit the payment.",
      "",
      summary,
    ].join("\n"),
    { replyMarkup: webAppButton("Open to confirm payment", url) },
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

function formatPickerLine(t: Tournament, gameNames: Map<string, string>): string {
  const game = gameNames.get(t.gameAddress.toLowerCase()) ?? shortAddr(t.gameAddress);
  const entries = `${t.entryCount} ${t.entryCount === 1 ? "entry" : "entries"}`;
  const fee = extractFee(t) ? " · paid" : " · free";
  return `#${t.id} ${t.name || "(unnamed)"} — ${game}${fee} · ${entries}`;
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

