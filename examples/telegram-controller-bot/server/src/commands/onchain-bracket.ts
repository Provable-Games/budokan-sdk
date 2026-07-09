// On-chain bracket flow — the OPEN/uncapped path, running on the `packages/bracket`
// contract instead of the off-chain tree (see commands/bracket.ts for the closed
// path). Two user-facing writes: the organizer `create_bracket`s, then players
// `register` (escrowing their fee). Everything after registration closes —
// VRF seeding, building the gated tree, auto-entering round-1 players, and
// advancement — is driven by the budokan-bots init + advance engines, so this
// bot's job ends at "created + collecting registrations".

import {
  CHAINS,
  BRACKET_STATUS,
  buildCreateBracketCall,
  buildBracketRegisterCalls,
  createBudokanClient,
  normalizeAddress,
  parseBracketIdFromReceipt,
  tournamentPageUrl,
  type CreateBracketConfig,
} from "@provable-games/budokan-sdk";
import { createDenshokanClient } from "@provable-games/denshokan-sdk";
import { RpcProvider, TransactionFinalityStatus } from "starknet";

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

// Fast confirmation (mirrors death-mountain-client): poll frequently and resolve
// at PRE_CONFIRMED rather than blocking on a full ACCEPTED_ON_L2 block — cuts
// register/sponsor/create feedback from ~20s (default) to a few seconds.
const FAST_WAIT = {
  retryInterval: 500,
  successStates: [
    TransactionFinalityStatus.PRE_CONFIRMED,
    TransactionFinalityStatus.ACCEPTED_ON_L2,
    TransactionFinalityStatus.ACCEPTED_ON_L1,
  ],
};

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
    const receipt = (await rpc.waitForTransaction(tx.transaction_hash, FAST_WAIT)) as {
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
    await rpc.waitForTransaction(tx.transaction_hash, FAST_WAIT);
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
    await rpc.waitForTransaction(tx.transaction_hash, FAST_WAIT);
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


// ---------------------------------------------------------------------------
// Lifecycle CTAs — "your match is ready" (every round) + "champion" (final).
//
// The budokan-bots engines seed/build/seat/advance/settle a bracket HEADLESSLY,
// so nothing tells players their match is live or who won. This tick watches
// each tracked bracket and posts, once each:
//   • a "ready to play" CTA per match, the moment both its players are entered
//     (round 1 at seating; later rounds as feeder winners advance in), grouped
//     into one message per round, and
//   • a "🏆 champion" message when the final resolves.
// Player identities + the winner come from denshokan (getTokens scoped to the
// match tournament by minter+context); the tree shape is the round-major layout
// of packages/bracket.
// ---------------------------------------------------------------------------

// Round-major index helpers — mirror packages/bracket lib.cairo. `field` is a
// power of two; total matches = field - 1, indexed round 1 first, bottom-up.
function bracketRounds(field: number): number {
  return Math.max(1, Math.round(Math.log2(field)));
}
function roundMatchStart(field: number, round: number): number {
  return field - field / 2 ** (round - 1);
}
function roundMatchCount(field: number, round: number): number {
  return field / 2 ** round;
}
function locateMatch(field: number, matchIndex: number): { round: number; indexInRound: number } {
  const rounds = bracketRounds(field);
  for (let r = 1; r <= rounds; r++) {
    const start = roundMatchStart(field, r);
    if (matchIndex < start + roundMatchCount(field, r)) {
      return { round: r, indexInRound: matchIndex - start };
    }
  }
  return { round: rounds, indexInRound: 0 };
}
function roundLabel(round: number, rounds: number): string {
  if (round >= rounds) return "Final";
  if (round === rounds - 1) return "Semifinal";
  if (round === rounds - 2) return "Quarterfinal";
  return `Round ${round}`;
}

/** A match tournament's entrant, enriched by denshokan. */
interface MatchEntrant {
  owner: string;
  playerName?: string;
  score: number;
  gameOver: boolean;
}

function displayEntrant(oc: OnchainBracket, e: { owner?: string; playerName?: string }): string {
  const n = e.playerName?.trim();
  if (n) return n;
  const owner = (e.owner ?? "").toLowerCase();
  if (owner && oc.names?.[owner]) return oc.names[owner];
  return owner && owner !== "0x0" ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : "TBD";
}

/** denshokan entrants for a match tournament (minter = budokan, context = tid),
 *  score-sorted desc so [0] is the leader once played. */
async function matchEntrants(chain: Chain, budokanAddr: string, tid: string): Promise<MatchEntrant[]> {
  const denshokan = createDenshokanClient({ chain });
  const res = await denshokan.getTokens({
    minterAddress: normalizeAddress(budokanAddr),
    contextId: Number(tid),
    sort: { field: "score", direction: "desc" },
    limit: 16,
  });
  return (res.data as Array<{ owner?: string; playerName?: string; score?: number; gameOver?: boolean }>).map(
    (t) => ({ owner: t.owner ?? "0x0", playerName: t.playerName, score: Number(t.score ?? 0), gameOver: Boolean(t.gameOver) }),
  );
}

/**
 * One pass over tracked on-chain brackets: for each RUNNING bracket, post a
 * "ready to play" CTA for any match that has just become playable (both players
 * entered), grouped by round, and a "champion" message once the final resolves.
 * Idempotent via `announcedMatchTids` + `championAnnouncedAt`.
 */
export async function announceBracketProgress(api: TelegramApi, config: Config): Promise<void> {
  const store = onchainStore(config);
  let all: OnchainBracket[];
  try {
    all = await store.all();
  } catch (error) {
    console.error("announceBracketProgress: list failed:", formatError(error));
    return;
  }
  for (const oc of all) {
    if (oc.championAnnouncedAt) continue; // fully done
    try {
      await announceOneBracket(api, config, store, oc);
    } catch (error) {
      console.error(`announceBracketProgress: #${oc.bracketId} failed:`, formatError(error));
    }
  }
}

async function announceOneBracket(
  api: TelegramApi,
  config: Config,
  store: OnchainBracketStore,
  oc: OnchainBracket,
): Promise<void> {
  const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(oc.chain, config.rpcUrl) });
  const read = (entrypoint: string, calldata: string[]) =>
    rpc.callContract({ contractAddress: oc.contractAddress, entrypoint, calldata });

  const status = Number(BigInt((await read("get_config", [oc.bracketId]))[13] ?? "0"));
  if (status < BRACKET_STATUS.RUNNING) return; // tree not built yet
  const field = Number(BigInt((await read("field", [oc.bracketId]))[0] ?? "0"));
  if (field < 2) return;
  const rounds = bracketRounds(field);
  const budokanAddr = config.budokanAddress ?? CHAINS[oc.chain]?.budokanAddress;
  if (!budokanAddr) return;

  const announced = new Set(oc.announcedMatchTids ?? []);
  const readyByRound = new Map<number, Array<{ tid: string; a: string; b: string }>>();
  const total = field - 1; // matches [0, field-1); final is index total-1

  for (let k = 0; k < total; k++) {
    const tid = BigInt((await read("match_tournament", [oc.bracketId, String(k)]))[0] ?? "0");
    if (tid === 0n) continue; // not built yet
    const tidStr = tid.toString();
    if (announced.has(tidStr)) continue;
    const entrants = await matchEntrants(oc.chain, budokanAddr, tidStr);
    const [entA, entB] = entrants;
    if (!entA || !entB) continue; // both players not entered yet
    // Mark it seen either way so we don't re-query it every tick.
    announced.add(tidStr);
    // Only send a "play now" CTA if the match isn't already played out — avoids a
    // stale prompt when a bracket is first tracked mid-flight (or on redeploy).
    if (entrants.every((e) => e.gameOver)) continue;
    const { round } = locateMatch(field, k);
    const list = readyByRound.get(round) ?? [];
    list.push({ tid: tidStr, a: displayEntrant(oc, entA), b: displayEntrant(oc, entB) });
    readyByRound.set(round, list);
  }

  for (const [round, matches] of [...readyByRound.entries()].sort((x, y) => x[0] - y[0])) {
    const label = roundLabel(round, rounds);
    const title = oc.namePrefix ? `${oc.namePrefix} — ${label}` : label;
    const text = [
      `🥊 ${title} is ready!`,
      "",
      "Players, tap your match to play. Winners advance automatically — good luck! 🎮",
    ].join("\n");
    const buttons: InlineKeyboardButton[][] = matches.map((m) => [
      { text: `▶️ ${m.a} vs ${m.b}`, url: tournamentPageUrl(oc.chain, m.tid) },
    ]);
    await api.sendMessage(oc.announceChatId, text, { replyMarkup: { inline_keyboard: buttons } });
  }

  if (announced.size !== (oc.announcedMatchTids?.length ?? 0)) {
    oc.announcedMatchTids = [...announced];
    await store.save(oc);
  }

  // Champion: the final match resolves last. Announce once its tournament is
  // finalized (submission window closed → results final).
  const finalTid = BigInt((await read("match_tournament", [oc.bracketId, String(total - 1)]))[0] ?? "0");
  if (finalTid === 0n) return;
  const budokan = createBudokanClient({
    chain: oc.chain,
    ...(config.apiUrl ? { apiBaseUrl: config.apiUrl } : {}),
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.budokanAddress ? { budokanAddress: config.budokanAddress } : {}),
    ...(config.viewerAddress ? { viewerAddress: config.viewerAddress } : {}),
  } as Parameters<typeof createBudokanClient>[0]);
  const finalT = await budokan.getTournament(finalTid.toString()).catch(() => null);
  if (!finalT || finalT.phase !== "finalized") return;

  const finalists = await matchEntrants(oc.chain, budokanAddr, finalTid.toString());
  const champ = finalists.find((e) => e.gameOver || e.score > 0) ?? finalists[0];
  if (!champ) return;
  await api.sendMessage(
    oc.announceChatId,
    [
      `🏆 ${displayEntrant(oc, champ)} wins ${oc.namePrefix ?? `bracket #${oc.bracketId}`}!`,
      "",
      "Congratulations to the champion. GG to everyone who played. 🎉",
      tournamentPageUrl(oc.chain, finalTid.toString()),
    ].join("\n"),
  );
  oc.championAnnouncedAt = Math.floor(Date.now() / 1000);
  await store.save(oc);
}
