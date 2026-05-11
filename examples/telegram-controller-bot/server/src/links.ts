// URL formatters and tx-receipt event parsing for chat-rendered output.
//
// MIGRATION NOTE: lifted into the SDK as `explorerTxUrl` /
// `tournamentPageUrl` / `parseTournamentIdFromReceipt`. Once
// @provable-games/budokan-sdk@0.1.24 publishes and the bot's dep bumps,
// delete this file and switch imports to the SDK.

import { hash } from "starknet";

import type { Chain } from "./chat-state.ts";

/** Voyager block-explorer base URL for the chain. */
export function explorerBaseUrl(chain: Chain): string {
  return chain === "sepolia"
    ? "https://sepolia.voyager.online"
    : "https://voyager.online";
}

/** Shareable Voyager link for a tx hash. */
export function explorerTxUrl(chain: Chain, txHash: string): string {
  return `${explorerBaseUrl(chain)}/tx/${txHash}`;
}

/**
 * Canonical budokan.gg URL for a tournament page. The `network` query
 * param tells the client which chain to load — important when sharing
 * sepolia tournaments since the site defaults to mainnet.
 */
export function tournamentPageUrl(
  chain: Chain,
  tournamentId: string | number,
): string {
  return `https://budokan.gg/tournament/${tournamentId}?network=${chain}`;
}

// Selector for the `TournamentCreated` event on the budokan contract.
// `event.keys[0]` is the selector; the indexed tournament id lives at
// `event.keys[1]`.
const TOURNAMENT_CREATED_SELECTOR = hash.getSelectorFromName(
  "TournamentCreated",
);

/** Minimal receipt shape — what every Starknet RPC returns. */
export interface ReceiptWithEvents {
  events?: Array<{ from_address?: string; keys?: string[] }>;
}

/**
 * Extract the new tournament's id from a `create_tournament` tx receipt.
 * Returns undefined if no matching event is found.
 */
export function parseTournamentIdFromReceipt(
  receipt: ReceiptWithEvents,
  budokanAddress: string,
): number | undefined {
  const normalise = (addr: string) =>
    addr.toLowerCase().replace(/^0x0*/, "0x");
  const normContract = normalise(budokanAddress);
  for (const event of receipt.events ?? []) {
    if (!event.from_address || !event.keys || event.keys.length < 2) continue;
    if (normalise(event.from_address) !== normContract) continue;
    if (event.keys[0] !== TOURNAMENT_CREATED_SELECTOR) continue;
    return Number(BigInt(event.keys[1]!));
  }
  return undefined;
}
