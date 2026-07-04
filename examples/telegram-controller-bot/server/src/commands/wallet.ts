// /wallet — show the connected account's balances + on-chain approvals for the
// tokens in the session policy set, with one-tap "bump if low" actions.
//
// Why only the policy-set tokens (not every Voyager balance): those are the
// tokens the bot can actually spend in-session (each is authorized for `approve`
// at /connect with a per-token spending cap — see policies.ts + catalog/tokens.ts).
// So for each we can line up the three numbers a user cares about before paying
// an entry fee: what they HOLD (Voyager balance), what they've ALREADY APPROVED
// to Budokan on-chain (ERC20 allowance), and the session CAP the bot may approve
// up to. Balances come from the Voyager proxy; allowances are read straight from
// the token contract.
//
// "Bump if needed": a low balance → the /topup deeplink; an expired / narrowed
// session (so the caps no longer apply) → a Re-connect button that re-runs
// /connect. The per-token caps themselves are fixed by the operator in
// catalog/tokens.ts — the session can't exceed them — so there's no "raise the
// cap" action here by design.

import { RpcProvider } from "starknet";
import { CHAINS, normalizeAddress } from "@provable-games/budokan-sdk";

import type { Config } from "../config.ts";
import type { Chain } from "../chat-state.ts";
import type { TelegramApi } from "../telegram-api.ts";
import type { SessionStore } from "../session-store.ts";
import { keychainSafeRpcUrl } from "../cartridge-link.ts";
import { tokensForChain } from "../catalog/tokens.ts";
import { fetchVoyagerBalances, type VoyagerTokenBalance } from "../voyager.ts";
import { formatTokenAmount } from "../format.ts";
import { formatError } from "../format-error.ts";
import { buildTopupUrl } from "./topup.ts";
import type { InlineKeyboardButton } from "../telegram-api.ts";

export async function wallet(
  api: TelegramApi,
  config: Config,
  sessions: SessionStore,
  chatId: string,
  chain: Chain,
  botUsername: string,
): Promise<void> {
  const stored = await sessions.get(chatId, chain);
  if (!stored) {
    await api.sendMessage(
      chatId,
      `Not connected on ${chain} — run /connect first, then /wallet to see your balances and approvals.`,
    );
    return;
  }
  const owner = stored.session.address;
  const budokan = config.budokanAddress ?? CHAINS[chain]?.budokanAddress;

  // Only the policy-set tokens (the ones with a session spending cap) — those
  // are the tokens the bot can spend and the only ones an allowance to Budokan
  // is meaningful for.
  const tokens = tokensForChain(chain).filter((t) => t.spendLimit);
  if (tokens.length === 0) {
    await api.sendMessage(chatId, `No spendable tokens are configured for ${chain}.`);
    return;
  }

  // Balances (Voyager) and allowances (on-chain) are independent — fetch both
  // concurrently. Either can fail without sinking the whole view.
  const rpc = new RpcProvider({ nodeUrl: keychainSafeRpcUrl(chain, config.rpcUrl) });
  const [balances, allowances] = await Promise.all([
    fetchVoyagerBalances(config.voyagerProxyUrl, owner, config.voyagerProxyToken).catch(
      (error) => ({ error: formatError(error) }) as const,
    ),
    Promise.all(
      tokens.map((t) =>
        budokan
          ? readAllowance(rpc, t.address, owner, budokan).catch(() => null)
          : Promise.resolve(null),
      ),
    ),
  ]);

  const balanceOf = buildBalanceMap(Array.isArray(balances) ? balances : []);

  const lines: string[] = [
    `👛 Wallet on ${chain}`,
    `${stored.session.username} · ${shortAddr(owner)}`,
    "",
  ];

  if (!Array.isArray(balances)) {
    lines.push(`⚠️ Couldn't load balances: ${balances.error}`, "");
  }

  tokens.forEach((token, i) => {
    const bal = balanceOf.get(normalizeAddress(token.address));
    const balStr = bal ? formatTokenAmount(bal.balance, bal.decimals) : "0";
    const usd = bal?.usdBalance !== undefined ? ` ($${bal.usdBalance.toFixed(2)})` : "";
    const cap = formatTokenAmount(token.spendLimit!, token.decimals);
    const allowance = allowances[i] ?? null;
    const allowanceStr =
      allowance === null ? "—" : formatTokenAmount(allowance.toString(), token.decimals);

    lines.push(
      `• ${token.symbol}: ${balStr}${usd}`,
      `    approved to Budokan: ${allowanceStr} · session cap: ${cap}`,
    );
  });

  // A missing/garbled expiry must not crash the command — new Date(NaN)
  // .toISOString() throws. Fall back to treating it as expired/unknown.
  const expiresAt = new Date(Number(stored.session.expiresAt) * 1000);
  const validExpiry = !Number.isNaN(expiresAt.getTime());
  const expired = !validExpiry || expiresAt.getTime() <= Date.now();
  const expiryStr = validExpiry
    ? `${expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "an unknown time";
  lines.push(
    "",
    expired
      ? `⚠️ Session expired ${expiryStr} — Re-connect to restore your spending limits.`
      : `Session valid until ${expiryStr}.`,
    "",
    "Low on a token? Top up. Approvals are granted per-payment up to the session cap; if the session lapsed, Re-connect.",
  );

  // Bump actions: Top up (funds) + Re-connect (refresh session/limits).
  const buttons: InlineKeyboardButton[][] = [];
  if (config.topupUrl) {
    const returnUrl = botUsername ? `https://t.me/${botUsername}` : config.botPublicUrl;
    buttons.push([{ text: "💰 Top up", url: buildTopupUrl(config.topupUrl, owner, returnUrl) }]);
  }
  buttons.push([{ text: "🔄 Re-connect (refresh limits)", callback_data: "wconnect" }]);

  await api.sendMessage(chatId, lines.join("\n"), {
    replyMarkup: { inline_keyboard: buttons },
  });
}

/** Read ERC20 `allowance(owner, spender)` and decode the u256 result. */
async function readAllowance(
  rpc: RpcProvider,
  tokenAddress: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const res = await rpc.callContract({
    contractAddress: tokenAddress,
    entrypoint: "allowance",
    calldata: [owner, spender],
  });
  return u256(res[0], res[1]);
}

/** Combine an ERC20 u256 `[low, high]` felt pair into a bigint. */
function u256(low: string | undefined, high: string | undefined): bigint {
  return BigInt(low ?? "0") + (BigInt(high ?? "0") << 128n);
}

/** Index Voyager balances by normalized address for lookup against the catalog. */
function buildBalanceMap(balances: VoyagerTokenBalance[]): Map<string, VoyagerTokenBalance> {
  const map = new Map<string, VoyagerTokenBalance>();
  for (const b of balances) map.set(normalizeAddress(b.tokenAddress), b);
  return map;
}

function shortAddr(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}
