// /add_prize [tournamentId] — sponsor an ERC-20 prize on a tournament.
//
// In-bot flow (pick tournament → pick token → amount → position → confirm):
// the bot approves the prize token and calls add_prize in one in-session
// multicall, using the same per-token spending limit authorized at /connect
// (policies.ts + catalog/tokens.ts). Only the pre-authorized tokens, and only
// up to the limit, are eligible — anything else (NFT prizes, exotic tokens,
// amounts over the cap, distributed payouts) falls back to the budokan.gg
// "Add Prizes" UI, which signs in a real browser.

import {
  buildAddPrizeCall,
  buildErc20ApproveCall,
  createBudokanClient,
  CHAINS,
} from "@provable-games/budokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import type { HandshakeStore } from "../handshake.ts";
import { TelegramApi } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { gamesForChain } from "../catalog/games.ts";
import { tokensForChain, type Erc20Token } from "../catalog/tokens.ts";
import { formatError } from "../format-error.ts";
import { explorerTxUrl, tournamentPageUrl } from "@provable-games/budokan-sdk";

type Step = "tournamentPick" | "tokenPick" | "amount" | "position" | "confirm";

interface State {
  step: Step;
  chain: Chain;
  // tournamentPick
  pickerTournaments: Array<{ id: string; name: string; gameAddress: string; entryCount: number }>;
  pickerGameNames: Map<string, string>;
  // selection so far
  tournamentId?: string;
  tournamentName?: string;
  tokens: Erc20Token[]; // eligible (spend-limit) tokens offered at tokenPick
  token?: Erc20Token;
  amountRaw?: string; // base units
  amountDisplay?: string;
  position?: number;
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
  chatId: string,
  chain: Chain,
  args: string[],
): Promise<void> {
  const eligible = tokensForChain(chain).filter((t): t is Erc20Token & { spendLimit: string } => !!t.spendLimit);

  // Explicit id: jump straight to token selection (gated on an existing session).
  if (args.length === 1 && args[0] && /^\d+$/.test(args[0])) {
    const state: State = {
      step: "tokenPick",
      chain,
      pickerTournaments: [],
      pickerGameNames: new Map(),
      tournamentId: args[0],
      tournamentName: `#${args[0]}`,
      tokens: eligible,
    };
    states.set(chatId, state);
    await beginTokenPick(api, config, chatId, state);
    return;
  }
  if (args.length !== 0) {
    await api.sendMessage(chatId, "Usage: /add_prize [tournamentId]\nWith no id I'll show a picker.");
    return;
  }

  // No-args: show picker of non-finalized tournaments.
  const sdk = sdkClient(config, chain);
  const phasesToShow = ["scheduled", "registration", "staging", "live", "submission"] as const;
  let pool: State["pickerTournaments"];
  try {
    const lists = await Promise.all(
      phasesToShow.map((phase) =>
        sdk.getTournaments({ phase, limit: 25, sort: "created_at" }).then((r) => r.data),
      ),
    );
    const byId = new Map<string, State["pickerTournaments"][number]>();
    for (const list of lists) {
      for (const t of list) {
        byId.set(t.id, { id: t.id, name: t.name || "(unnamed)", gameAddress: t.gameAddress, entryCount: t.entryCount });
      }
    }
    pool = Array.from(byId.values()).sort((a, b) => Number(b.id) - Number(a.id));
  } catch (error) {
    await api.sendMessage(chatId, `Couldn't fetch tournaments: ${formatError(error)}`);
    return;
  }
  if (pool.length === 0) {
    await api.sendMessage(chatId, `No active tournaments on ${chain} to sponsor.`);
    return;
  }
  const gameNames = await buildGameNameMap(chain);
  states.set(chatId, { step: "tournamentPick", chain, pickerTournaments: pool, pickerGameNames: gameNames, tokens: eligible });

  const lines = [
    `Pick a tournament to sponsor on ${chain}:`,
    "",
    ...pool.map((t, i) => {
      const game = gameNames.get(t.gameAddress.toLowerCase()) ?? shortAddr(t.gameAddress);
      return `  ${i + 1}. #${t.id} ${t.name} — ${game} · ${t.entryCount} ${t.entryCount === 1 ? "entry" : "entries"}`;
    }),
    "",
    "Reply with a number, or /cancel.",
  ];
  await api.sendMessage(chatId, lines.join("\n"));
}

export async function handleAnswer(
  api: TelegramApi,
  config: Config,
  _handshakes: HandshakeStore,
  chatId: string,
  text: string,
): Promise<void> {
  const state = states.get(chatId);
  if (!state) return;
  const trimmed = text.trim();

  switch (state.step) {
    case "tournamentPick": {
      const n = pickIndex(trimmed, state.pickerTournaments.length);
      if (n === null) {
        await api.sendMessage(chatId, `Reply 1-${state.pickerTournaments.length}, or /cancel.`);
        return;
      }
      const chosen = state.pickerTournaments[n]!;
      state.tournamentId = chosen.id;
      state.tournamentName = chosen.name;
      await beginTokenPick(api, config, chatId, state);
      return;
    }

    case "tokenPick": {
      const n = pickIndex(trimmed, state.tokens.length);
      if (n === null) {
        await api.sendMessage(chatId, `Reply 1-${state.tokens.length}, or /cancel.`);
        return;
      }
      state.token = state.tokens[n]!;
      state.step = "amount";
      await api.sendMessage(chatId, `Amount of ${state.token.symbol} to put up (e.g. 100 or 2.5):`);
      return;
    }

    case "amount": {
      const token = state.token!;
      const raw = parseToBaseUnits(trimmed, token.decimals);
      if (raw === null || BigInt(raw) <= 0n) {
        await api.sendMessage(chatId, `Enter a positive ${token.symbol} amount (e.g. 100 or 2.5), or /cancel.`);
        return;
      }
      // Over the per-token session cap → can't sign in chat; deeplink instead.
      if (BigInt(raw) > BigInt(token.spendLimit!)) {
        states.delete(chatId);
        await api.sendMessage(
          chatId,
          [
            `That's above your in-chat ${token.symbol} spending limit. Sponsor it on budokan.gg:`,
            tournamentPageUrl(state.chain, state.tournamentId!),
          ].join("\n"),
        );
        return;
      }
      state.amountRaw = raw;
      state.amountDisplay = `${trimmed} ${token.symbol}`;
      state.step = "position";
      await api.sendMessage(chatId, "Which leaderboard position should win this prize? (1 = first place)");
      return;
    }

    case "position": {
      if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
        await api.sendMessage(chatId, "Enter a position ≥ 1 (1 = first place), or /cancel.");
        return;
      }
      state.position = Number(trimmed);
      state.step = "confirm";
      await api.sendMessage(
        chatId,
        [
          `Sponsor ${state.amountDisplay} to ${ordinal(state.position)} place on ${state.tournamentName}?`,
          "",
          "Reply 'yes' to sign in chat, or /cancel.",
        ].join("\n"),
      );
      return;
    }

    case "confirm": {
      if (!/^y(es)?$/i.test(trimmed)) {
        states.delete(chatId);
        await api.sendMessage(chatId, "Cancelled.");
        return;
      }
      states.delete(chatId);
      await execute(api, config, chatId, state);
      return;
    }
  }
}

async function execute(api: TelegramApi, config: Config, chatId: string, state: State): Promise<void> {
  const session = await resolveAccount(chatId, state.chain, config);
  if (!session.ok) {
    // Lost the session between confirm and sign — don't prompt a registration
    // for a one-off sponsor; send them to the page instead.
    await api.sendMessage(
      chatId,
      [
        "Couldn't sign in chat. Add your prize on the tournament page instead:",
        tournamentPageUrl(state.chain, state.tournamentId!),
      ].join("\n"),
    );
    return;
  }
  const budokanAddress = config.budokanAddress ?? CHAINS[state.chain]?.budokanAddress;
  if (!budokanAddress) {
    await api.sendMessage(chatId, `Internal error: no Budokan address for ${state.chain}.`);
    return;
  }

  const token = state.token!;
  await api.sendMessage(chatId, `⏳ Sponsoring ${state.amountDisplay} on ${state.tournamentName}…`);
  try {
    const approveCall = buildErc20ApproveCall(token.address, budokanAddress, state.amountRaw!);
    const addPrizeCall = buildAddPrizeCall(budokanAddress, {
      tournamentId: state.tournamentId!,
      prize: {
        kind: "token",
        tokenAddress: token.address,
        tokenType: { kind: "erc20", amount: state.amountRaw! },
        position: state.position!,
      },
    });
    const tx = await session.data.account.execute([approveCall, addPrizeCall]);
    await api.sendMessage(
      chatId,
      [
        `✅ Sponsored ${state.amountDisplay} to ${ordinal(state.position!)} place on ${state.tournamentName}`,
        `🔗 ${explorerTxUrl(state.chain, tx.transaction_hash)}`,
      ].join("\n"),
    );
  } catch (error) {
    await api.sendMessage(
      chatId,
      [
        `Couldn't sponsor in chat: ${formatError(error)}`,
        "",
        "Add it on budokan.gg instead:",
        tournamentPageUrl(state.chain, state.tournamentId!),
      ].join("\n"),
    );
  }
}

// Enter the in-chat token flow only when a session already covers it. Adding a
// prize is a one-off, so it isn't worth prompting a (gas-costing) session
// registration: without a usable session — or for prizes that can't be signed
// in chat (NFTs, unlisted tokens, amounts over the cap) — we just point the
// user at the tournament page.
async function beginTokenPick(
  api: TelegramApi,
  config: Config,
  chatId: string,
  state: State,
): Promise<void> {
  const session = await resolveAccount(chatId, state.chain, config);
  if (!session.ok || state.tokens.length === 0) {
    states.delete(chatId);
    await api.sendMessage(
      chatId,
      [
        `Sponsor a prize on ${state.tournamentName}:`,
        tournamentPageUrl(state.chain, state.tournamentId!),
        "",
        "(Adding a prize is a one-off, so it's done on the tournament page — no need to register a session just for this.)",
      ].join("\n"),
    );
    return;
  }
  state.step = "tokenPick";
  await promptToken(api, chatId, state.tokens, state.chain, state.tournamentId!);
}

async function promptToken(
  api: TelegramApi,
  chatId: string,
  tokens: Erc20Token[],
  chain: Chain,
  tournamentId: string,
): Promise<void> {
  await api.sendMessage(
    chatId,
    [
      "Which token? (only tokens with a spending limit can be signed in chat)",
      "",
      ...tokens.map((t, i) => `  ${i + 1}. ${t.symbol} — ${t.name}`),
      "",
      "Reply with a number, or /cancel.",
      `For an NFT or a token not listed, add it on the tournament page: ${tournamentPageUrl(chain, tournamentId)}`,
    ].join("\n"),
  );
}

function pickIndex(text: string, len: number): number | null {
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (n < 1 || n > len) return null;
  return n - 1;
}

// Decimal token amount → base-unit string. Returns null on parse failure.
// Accepts "1", "0.5", "10.123456789" (truncates beyond `decimals`).
function parseToBaseUnits(input: string, decimals: number): string | null {
  const t = input.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
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

async function buildGameNameMap(chain: Chain): Promise<Map<string, string>> {
  const games = await gamesForChain(chain);
  const map = new Map<string, string>();
  for (const g of games) map.set(g.contractAddress.toLowerCase(), g.name);
  return map;
}

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}
