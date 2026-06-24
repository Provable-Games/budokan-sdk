// /add_prize [tournamentId] — direct the user to budokan.gg to sponsor an
// ERC-20 prize on a tournament.
//
// We used to walk the user through a long Q&A (pick token from Voyager
// balances, amount, single vs distributed payout, distribution type,
// weight) and then push approve + add_prize through a Mini App that
// wrapped Cartridge's ControllerProvider. The Mini App turned out
// unusable inside Telegram's in-app webview — Cartridge's keychain
// can't get a connected account there ("Cartridge did not return a
// connected account"), and @cartridge/controller@0.10.7 doesn't bundle
// the JS for its TelegramProvider preset. See enter.ts for the same
// rationale.
//
// budokan.gg has a working "Add Prizes" UI on the tournament page.
// Sending the user a deeplink lets them complete the sponsorship in a
// real browser. No Q&A in chat — the website prompts for the same
// fields and shows accurate balances + USD values via the same Voyager
// integration on the client side.

import { createBudokanClient } from "@provable-games/budokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import type { HandshakeStore } from "../handshake.ts";
import { TelegramApi } from "../telegram-api.ts";
import { gamesForChain } from "../catalog/games.ts";
import { formatError } from "../format-error.ts";
import { tournamentPageUrl } from "../links.ts";

type Step = "tournamentPick";

interface State {
  step: Step;
  chain: Chain;
  // Tournaments offered in the current picker render. Cleared once the
  // user picks (or /cancels).
  pickerTournaments: Array<{
    id: string;
    name: string;
    gameAddress: string;
    entryCount: number;
  }>;
  pickerGameNames: Map<string, string>;
}

const states = new Map<string, State>();

export function isPending(chatId: string): boolean {
  return states.has(chatId);
}

export function cancel(chatId: string): boolean {
  return states.delete(chatId);
}

/**
 * Kick off /add_prize [tournamentId]. With an id we go straight to the
 * deeplink. Without, fetch non-finalized tournaments and let the user
 * pick one.
 */
export async function start(
  api: TelegramApi,
  config: Config,
  chatId: string,
  chain: Chain,
  args: string[],
): Promise<void> {
  // Explicit id: skip the picker.
  if (args.length === 1 && args[0] && /^\d+$/.test(args[0])) {
    return sendDeeplink(api, chatId, chain, args[0]);
  }
  if (args.length !== 0) {
    await api.sendMessage(
      chatId,
      "Usage: /add_prize [tournamentId]\nWith no id I'll show a picker.",
    );
    return;
  }

  // No-args: show picker of non-finalized tournaments.
  const sdk = sdkClient(config, chain);
  const phasesToShow = [
    "scheduled",
    "registration",
    "staging",
    "live",
    "submission",
  ] as const;
  let pool: State["pickerTournaments"];
  try {
    const lists = await Promise.all(
      phasesToShow.map((phase) =>
        sdk
          .getTournaments({ phase, limit: 25, sort: "created_at" })
          .then((r) => r.data),
      ),
    );
    const byId = new Map<string, State["pickerTournaments"][number]>();
    for (const list of lists) {
      for (const t of list) {
        byId.set(t.id, {
          id: t.id,
          name: t.name || "(unnamed)",
          gameAddress: t.gameAddress,
          entryCount: t.entryCount,
        });
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

  states.set(chatId, {
    step: "tournamentPick",
    chain,
    pickerTournaments: pool,
    pickerGameNames: gameNames,
  });

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

/**
 * Dispatcher entrypoint for plain-text replies. Signature mirrors the
 * other multi-turn commands so telegram.ts can call them uniformly;
 * `_handshakes` is unused — we don't mint Mini App handshakes anymore.
 */
export async function handleAnswer(
  api: TelegramApi,
  _config: Config,
  _handshakes: HandshakeStore,
  chatId: string,
  text: string,
): Promise<void> {
  const state = states.get(chatId);
  if (!state) return;
  if (state.step !== "tournamentPick") return;

  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    await api.sendMessage(chatId, `Reply 1-${state.pickerTournaments.length}, or /cancel.`);
    return;
  }
  const n = Number(trimmed);
  if (n < 1 || n > state.pickerTournaments.length) {
    await api.sendMessage(chatId, `Out of range. Pick 1–${state.pickerTournaments.length}, or /cancel.`);
    return;
  }
  const chosen = state.pickerTournaments[n - 1]!;
  states.delete(chatId);
  await sendDeeplink(api, chatId, state.chain, chosen.id, chosen.name);
}

/**
 * Send the budokan.gg deeplink + a one-line nudge. Optionally takes the
 * tournament name so the message reads naturally; if omitted (direct-id
 * path) we just print the id.
 */
async function sendDeeplink(
  api: TelegramApi,
  chatId: string,
  chain: Chain,
  tournamentId: string,
  tournamentName?: string,
): Promise<void> {
  const label = tournamentName
    ? `tournament #${tournamentId} — ${tournamentName}`
    : `tournament #${tournamentId}`;
  await api.sendMessage(
    chatId,
    [
      `Sponsor a prize on ${label}:`,
      tournamentPageUrl(chain, tournamentId),
      "",
      "Open the link in your normal browser, then click 'Add Prize'. Cartridge",
      "doesn't authenticate reliably inside Telegram's in-app browser, which is",
      "why the chat doesn't sign it directly.",
    ].join("\n"),
  );
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
