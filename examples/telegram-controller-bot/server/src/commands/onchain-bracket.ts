// On-chain bracket flow — the OPEN/uncapped path, running on the `packages/bracket`
// contract instead of the off-chain tree (see commands/bracket.ts for the closed
// path). Two user-facing writes: the organizer `create_bracket`s, then players
// `register` (escrowing their fee). Everything after registration closes —
// VRF seeding, building the gated tree, auto-entering round-1 players, and
// advancement — is driven by the budokan-bots init + advance engines, so this
// bot's job ends at "created + collecting registrations".

import {
  CHAINS,
  buildCreateBracketCall,
  buildBracketRegisterCalls,
  parseBracketIdFromReceipt,
  type CreateBracketConfig,
} from "@provable-games/budokan-sdk";
import { RpcProvider } from "starknet";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import { TelegramApi, type InlineKeyboardButton } from "../telegram-api.ts";
import { resolveAccount } from "../controller-account.ts";
import { keychainSafeRpcUrl } from "../cartridge-link.ts";
import { formatError } from "../format-error.ts";
import { OnchainBracketStore, type OnchainBracket } from "../onchain-bracket-store.ts";

// The controller session's `execute` wants concrete `calldata: string[]`; the
// SDK call builders return starknet `Call` (calldata typed as the looser
// RawArgs). CallData.compile always yields a felt string[] at runtime, so narrow
// it for the session executor.
type ExecCall = { contractAddress: string; entrypoint: string; calldata: string[] };
const toExec = (c: { contractAddress: string; entrypoint: string; calldata?: unknown }): ExecCall => ({
  contractAddress: c.contractAddress,
  entrypoint: c.entrypoint,
  calldata: (c.calldata ?? []) as string[],
});

/** Lazily-built store, keyed off the bot data dir (same root as BracketStore). */
let storeSingleton: OnchainBracketStore | undefined;
export function onchainStore(config: Config): OnchainBracketStore {
  return (storeSingleton ??= new OnchainBracketStore(config.dataDir));
}

/** Everything createOnchainBracket needs from the /bracket draft. */
export interface CreateOnchainParams {
  chain: Chain;
  gameAddress: string;
  gameName: string;
  leaderboardAscending: boolean;
  gameMustBeOver: boolean;
  settingsId: number;
  /** 0 = uncapped, else a power of two >= 2. */
  size: number;
  /** Per-match game duration + submission window, seconds. */
  gameDuration: number;
  submissionDuration: number;
  /** Seconds from now until registration closes (= round-1 start anchor). */
  startDelaySec: number;
  namePrefix?: string;
  description?: string;
  entryFee?: { tokenAddress: string; amount: string; label: string; symbol: string };
  /** Final-match placement split, basis points (sum 10000). Empty ⇒ winner-take-all. */
  tiersBps?: number[];
}

export async function createOnchainBracket(
  api: TelegramApi,
  config: Config,
  p: CreateOnchainParams,
  organizerChatId: string,
  announceChatId: string,
): Promise<void> {
  const chain = p.chain;
  const session = await resolveAccount(organizerChatId, chain, config);
  if (!session.ok) {
    await api.sendMessage(organizerChatId, `Not connected on ${chain} — run /connect first (the organizer creates the bracket).`);
    return;
  }
  const bracketAddress = CHAINS[chain]?.bracketAddress;
  if (!bracketAddress) {
    await api.sendMessage(organizerChatId, `Internal error: no bracket contract for ${chain}.`);
    return;
  }
  // The on-chain final is a single 2-player match, so the escrowed pool can only
  // split across champion + runner-up. A deeper split (Top 4/Top 8) would revert
  // when the bots build the final — reject it up front rather than mid-build.
  if ((p.tiersBps?.length ?? 0) > 2) {
    await api.sendMessage(
      organizerChatId,
      `On-chain brackets can only split the prize across the top 2 places (champion + runner-up). Recreate it with winner-take-all or a 2-way split.`,
    );
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const registrationDeadline = now + p.startDelaySec;
  const entryFee = p.entryFee ? p.entryFee.amount : "0";
  // The contract requires a non-zero fee token only when entry_fee > 0.
  const feeToken = p.entryFee?.tokenAddress ?? "0x0";
  const bracketConfig: CreateBracketConfig = {
    game: p.gameAddress,
    size: p.size,
    settingsId: p.settingsId,
    entryFee,
    feeToken,
    registrationDeadline,
    gameDuration: p.gameDuration,
    submissionDuration: p.submissionDuration,
    leaderboardAscending: p.leaderboardAscending,
    gameMustBeOver: p.gameMustBeOver,
  };
  const call = buildCreateBracketCall(bracketAddress, bracketConfig, p.tiersBps ?? []);

  const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(chain, config.rpcUrl) });
  await api.sendMessage(organizerChatId, `⏳ Creating the on-chain bracket…`);
  let bracketId: bigint | undefined;
  try {
    const tx = await session.data.account.execute([toExec(call)]);
    const receipt = (await rpc.waitForTransaction(tx.transaction_hash)) as {
      events?: Array<{ from_address?: string; keys?: string[] }>;
    };
    bracketId = parseBracketIdFromReceipt(receipt, bracketAddress);
  } catch (error) {
    await api.sendMessage(organizerChatId, `❌ Couldn't create the bracket: ${formatError(error)}`);
    return;
  }
  if (bracketId === undefined) {
    await api.sendMessage(organizerChatId, `❌ Bracket tx landed but I couldn't read its id — check the contract on ${chain}.`);
    return;
  }

  const store = onchainStore(config);
  const oc: OnchainBracket = {
    id: OnchainBracketStore.idFor(chain, bracketId.toString()),
    bracketId: bracketId.toString(),
    contractAddress: bracketAddress,
    chain,
    size: p.size,
    organizerChatId,
    announceChatId,
    namePrefix: p.namePrefix ?? p.gameName.slice(0, 24),
    ...(p.description ? { description: p.description } : {}),
    ...(p.entryFee
      ? { paid: { tokenAddress: p.entryFee.tokenAddress, fee: p.entryFee.amount, symbol: p.entryFee.symbol, label: p.entryFee.label } }
      : {}),
    registrationDeadline,
    createdAt: now,
  };
  await store.save(oc);

  const mid = await api.sendCard(oc.announceChatId, onchainCard(oc), onchainJoinKeyboard(oc)).catch(() => undefined);
  if (mid !== undefined) {
    oc.cardChatId = oc.announceChatId;
    oc.cardMessageId = mid;
    await store.save(oc);
  }

  const sizeLine = oc.size === 0 ? "uncapped (register until the deadline)" : `${oc.size} players`;
  await api.sendMessage(
    organizerChatId,
    `✅ On-chain bracket #${oc.bracketId} created (${sizeLine}). Registration closes ${deadlineSummary(oc.registrationDeadline)} — then it's seeded on-chain automatically.\n\n🏆 Add a prize pool on budokan.gg after seeding (to the bracket's final match).`,
  );
}

/** Register the joiner (self-service escrow) via their session. Returns a toast. */
export async function registerForOnchainBracket(
  api: TelegramApi,
  config: Config,
  ocId: string,
  joinerChatId: string,
): Promise<string> {
  const store = onchainStore(config);
  const oc = await store.get(ocId);
  if (!oc) return "That bracket isn't open for registration.";
  if (Math.floor(Date.now() / 1000) >= oc.registrationDeadline) {
    return "Registration has closed for this bracket.";
  }
  const chain = oc.chain;
  const session = await resolveAccount(joinerChatId, chain, config);
  if (!session.ok) return "DM me first: open the bot, /connect, then try again.";

  const addr = session.data.address.toLowerCase();
  if (oc.registered?.includes(addr)) return `You're already registered.`;

  const fee = oc.paid ? oc.paid.fee : "0";
  const feeToken = oc.paid?.tokenAddress ?? "0x0";
  // Self-register: the caller both pays and plays, so recipient = own address.
  const calls = buildBracketRegisterCalls(
    oc.contractAddress,
    feeToken,
    BigInt(oc.bracketId),
    session.data.address,
    fee,
  );
  try {
    const tx = await session.data.account.execute(calls.map(toExec));
    const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(chain, config.rpcUrl) });
    await rpc.waitForTransaction(tx.transaction_hash);
  } catch (error) {
    const msg = formatError(error);
    if (/already registered/i.test(msg)) return "You're already registered.";
    if (/not registering|registration closed/i.test(msg)) return "Registration has closed for this bracket.";
    if (/full/i.test(msg)) return "Sorry — this bracket just filled up.";
    return `Couldn't register: ${msg}`;
  }

  oc.registered = [...new Set([...(oc.registered ?? []), addr])];
  oc.names = { ...(oc.names ?? {}), [addr]: session.data.username };
  await store.save(oc);
  await updateOnchainCard(api, oc);

  const paidPrefix = oc.paid ? `Paid ${oc.paid.label} — ` : "";
  return `✅ ${paidPrefix}you're registered! When registration closes you'll be auto-entered into your round-1 match — watch for the play link.`;
}

/**
 * Sponsor `player` into an on-chain bracket: the sponsor's session pays the
 * escrow, `player` is seated + plays (register with recipient = player). Mirrors
 * the off-chain /sponsor; on-chain, overflow refunds go back to the sponsor.
 * `player` is already resolved (address + optional name) by the caller.
 */
export async function sponsorOnchainBracket(
  api: TelegramApi,
  config: Config,
  ocId: string,
  sponsorChatId: string,
  player: { address: string; name?: string },
): Promise<string> {
  const store = onchainStore(config);
  const oc = await store.get(ocId);
  if (!oc) return "That bracket isn't open for registration.";
  if (Math.floor(Date.now() / 1000) >= oc.registrationDeadline) {
    return "Registration has closed for this bracket.";
  }
  const recipient = player.address.toLowerCase();
  const displayName =
    player.name ?? `${player.address.slice(0, 6)}…${player.address.slice(-4)}`;
  if (oc.registered?.includes(recipient)) return `${displayName} is already registered.`;

  const session = await resolveAccount(sponsorChatId, oc.chain, config);
  if (!session.ok) {
    return "DM me first: open the bot, /connect, then try /sponsor again (you pay from your session).";
  }

  const fee = oc.paid ? oc.paid.fee : "0";
  const feeToken = oc.paid?.tokenAddress ?? "0x0";
  // Sponsor pays (caller = sponsor session), player is the recipient/seated.
  const calls = buildBracketRegisterCalls(
    oc.contractAddress,
    feeToken,
    BigInt(oc.bracketId),
    player.address,
    fee,
  );
  try {
    const tx = await session.data.account.execute(calls.map(toExec));
    const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(oc.chain, config.rpcUrl) });
    await rpc.waitForTransaction(tx.transaction_hash);
  } catch (error) {
    const msg = formatError(error);
    if (/already registered/i.test(msg)) return `${displayName} is already registered.`;
    if (/not registering|registration closed/i.test(msg)) return "Registration has closed for this bracket.";
    if (/full/i.test(msg)) return "Sorry — this bracket just filled up.";
    return `Couldn't sponsor: ${msg}`;
  }

  oc.registered = [...new Set([...(oc.registered ?? []), recipient])];
  oc.names = { ...(oc.names ?? {}), [recipient]: displayName };
  await store.save(oc);
  await updateOnchainCard(api, oc);

  const paidPrefix = oc.paid ? `Paid ${oc.paid.label} — ` : "";
  return `✅ ${paidPrefix}sponsored ${displayName}! They'll be auto-entered when registration closes.`;
}

// ----- card -----

function onchainCard(oc: OnchainBracket): string {
  const count = oc.registered?.length ?? 0;
  const lines = [
    "━━━━━━━━━━━━━━━━━━",
    `🥊 ${oc.namePrefix} — 1v1 Bracket (on-chain)`,
    "📊 Registration open",
    oc.size === 0 ? `👥 Registered: ${count} (uncapped)` : `👥 Registered: ${count}/${oc.size}`,
  ];
  // Roster of players who registered via the bot (names captured from their
  // Cartridge session). Capped so the card stays readable on a large field.
  const roster = (oc.registered ?? [])
    .map((a) => oc.names?.[a])
    .filter((n): n is string => Boolean(n));
  if (roster.length) {
    const shown = roster.slice(0, 20);
    for (const name of shown) lines.push(`  • ${name}`);
    if (roster.length > shown.length) lines.push(`  • …and ${roster.length - shown.length} more`);
  }
  if (oc.description) lines.push(`📝 ${oc.description}`);
  lines.push(oc.paid ? `💸 Entry: ${oc.paid.label} (escrowed into the prize pool)` : `💸 Entry: free`);
  lines.push(`⏱️ Registration closes ${deadlineSummary(oc.registrationDeadline)}`);
  lines.push("");
  lines.push(
    oc.size === 0
      ? "Register until the deadline — the field is then seeded on-chain (the largest power-of-two that filled plays; late/extra entries are refunded at random)."
      : `Register your slot — the field is seeded on-chain at the deadline (extras beyond a power-of-two are refunded).`,
  );
  lines.push("🎮 Tap Register — first /connect in a DM with me.");
  return lines.join("\n");
}

// Learned via getMe at startup (forwarded from bracket.ts's setBotUsername), for
// the Sponsor DM deeplink.
let botUsername = "";
export function setOnchainBotUsername(u: string): void {
  botUsername = u;
}

function onchainJoinKeyboard(oc: OnchainBracket): { inline_keyboard: InlineKeyboardButton[][] } {
  const label = oc.paid ? `🎮 Register — ${oc.paid.label}` : `🎮 Register (free)`;
  // Reuse the `bjoin:` callback the router already dispatches — joinViaButton
  // detects an on-chain id and routes to registerForOnchainBracket.
  const rows: InlineKeyboardButton[][] = [[{ text: label, callback_data: `bjoin:${oc.id}` }]];
  // Sponsor opens a DM scoped to this bracket via the `sponsor_` deeplink, which
  // startSponsorFlow routes to the on-chain path — the sponsor only types the
  // player, never the long id.
  if (botUsername) {
    rows.push([
      { text: `🎁 Sponsor a player`, url: `https://t.me/${botUsername}?start=sponsor_${oc.id}` },
    ]);
  }
  return { inline_keyboard: rows };
}

async function updateOnchainCard(api: TelegramApi, oc: OnchainBracket): Promise<void> {
  if (!oc.cardChatId || oc.cardMessageId === undefined) return;
  await api.editCard(oc.cardChatId, oc.cardMessageId, onchainCard(oc), onchainJoinKeyboard(oc)).catch(() => {});
}

/** "<UTC datetime> (in ~Nh)" for an absolute unix deadline. */
function deadlineSummary(deadlineSec: number): string {
  const at = new Date(deadlineSec * 1000);
  const when = at.toISOString().slice(0, 16).replace("T", " ");
  const delta = deadlineSec - Math.floor(Date.now() / 1000);
  const h = delta / 3600;
  const rel = h < 1 ? `${Math.max(0, Math.round(delta / 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
  return `${when} UTC (in ~${rel})`;
}
