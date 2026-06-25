// Shared output formatters for chat-rendered tournament data.
//
// Consolidated here so every command renders timing, prize totals, and
// token amounts the same way. Emoji are intentional and consistent — the
// user explicitly asked for a more visual treatment across all output;
// switching them off requires touching this file only.

import type { PrizeAggregation, Tournament } from "@provable-games/budokan-sdk";

import type { Chain } from "./chat-state.ts";
import { findKnownToken } from "./catalog/tokens.ts";

/** Format a raw u128/u256 amount into a human decimal string. */
export function formatTokenAmount(rawAmount: string, decimals: number): string {
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

/**
 * Compact duration formatter — at most two units, biggest first
 * ("2d 4h", "12h 30m", "45m", "30s"). Returns "0s" for non-positive.
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0s";
  const s = Math.floor(totalSeconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  // Pick the two highest non-zero units. Anything below the second unit
  // is noise at chat resolution.
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (parts.length < 2 && hours > 0) parts.push(`${hours}h`);
  if (parts.length < 2 && minutes > 0) parts.push(`${minutes}m`);
  if (parts.length < 2 && seconds > 0 && days === 0 && hours === 0) parts.push(`${seconds}s`);
  return parts.length === 0 ? "0s" : parts.join(" ");
}

/**
 * "Ends in 2d 4h" / "Ended 1h ago" / null when timestamp is missing.
 *
 * `unixTimestamp` may be a string (the indexer returns Unix seconds as
 * a string) or a number. Returns the relative phrase including a clock
 * emoji so callers can drop it straight into a line.
 */
export function formatTimeUntil(
  unixTimestamp: string | number | null | undefined,
  options: { prefix?: string; pastPrefix?: string } = {},
): string | null {
  if (unixTimestamp === null || unixTimestamp === undefined || unixTimestamp === "") {
    return null;
  }
  let target: number;
  try {
    target = typeof unixTimestamp === "number"
      ? unixTimestamp
      : Number(BigInt(unixTimestamp));
  } catch {
    return null;
  }
  if (!Number.isFinite(target) || target === 0) return null;

  const now = Math.floor(Date.now() / 1000);
  const diff = target - now;
  const prefix = options.prefix ?? "Ends in";
  const pastPrefix = options.pastPrefix ?? "Ended";
  if (diff > 0) return `⏰ ${prefix} ${formatDuration(diff)}`;
  if (diff === 0) return `⏰ ${prefix} now`;
  return `⏰ ${pastPrefix} ${formatDuration(-diff)} ago`;
}

/**
 * Render up to 3 token totals from a tournament's prizeAggregation,
 * "100 STRK · 50 USDC · 0.5 ETH". Known tokens resolve to symbol +
 * decimals; unknown tokens render as "<raw> <0x1234…>". Returns null
 * when the tournament has no sponsored prizes — caller decides what to
 * show in the empty case.
 *
 * Aggregation is per-token across all positions (not per-position), so
 * "top 3" here means "the three biggest token columns", which is the
 * most readable summary at chat width.
 */
export function formatTopPrizes(
  tournament: Tournament,
  chain: Chain,
  max: number = 3,
): string | null {
  const agg = tournament.prizeAggregation;
  if (!agg || agg.length === 0) return null;
  // The API doesn't order by USD value (it doesn't know prices). Sort
  // by token-native amount descending; for ERC-721 use nftCount as the
  // sort key. This is approximate but stable.
  const sorted = [...agg].sort((a, b) => {
    const aVal = a.tokenType === "erc721" ? BigInt(a.nftCount) : safeBigInt(a.totalAmount);
    const bVal = b.tokenType === "erc721" ? BigInt(b.nftCount) : safeBigInt(b.totalAmount);
    if (bVal > aVal) return 1;
    if (bVal < aVal) return -1;
    return 0;
  });
  const head = sorted.slice(0, max).map((p) => formatPrizeRow(p, chain));
  return head.join(" · ");
}

function formatPrizeRow(p: PrizeAggregation, chain: Chain): string {
  if (p.tokenType === "erc721") {
    return `${p.nftCount} NFT${p.nftCount === 1 ? "" : "s"}`;
  }
  const known = findKnownToken(chain, p.tokenAddress);
  if (known) {
    return `${formatTokenAmount(p.totalAmount, known.decimals)} ${known.symbol}`;
  }
  return `${p.totalAmount} (${shortAddr(p.tokenAddress)})`;
}

function safeBigInt(value: string | null | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Shortened hex form for inline display of long addresses / token ids,
 * "0x07ae26ee…c89202831". Exported so every command renders the fallback
 * the same way instead of each redefining its own shortAddr/shortHex.
 */
export function shortAddr(addr: string): string {
  if (!addr || addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

/**
 * Medal for top-3 leaderboard rows. Returns null for rank > 3 so the
 * caller can fall back to a numeric prefix.
 */
export function rankMedal(rank: number): string | null {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return null;
}

/**
 * English ordinal suffix for a position — 1 → "1st", 2 → "2nd", 3 → "3rd",
 * 11 → "11th", 21 → "21st". Used for prize positions and leaderboard ranks
 * beyond the top-3 medals so placements read naturally ("4th") rather than
 * as a bare "4.".
 */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * Rank prefix used by leaderboard rows: a medal for the top 3, otherwise the
 * ordinal position ("4th", "12th"). Keeps the visual treatment consistent
 * across every listing that ranks entries.
 */
export function rankPrefix(rank: number): string {
  return rankMedal(rank) ?? `${ordinal(rank)}`;
}

/**
 * Friendly game label for chat output: the real game name when we have it,
 * otherwise a shortened contract address. Centralizes the "name ?? shortAddr"
 * fallback that every listing was repeating, so games consistently show as
 * "Death Mountain" rather than "0x4de0351c…".
 */
export function formatGameLabel(
  gameAddress: string,
  names: Map<string, { name: string }> | Map<string, string>,
): string {
  const entry = names.get(gameAddress.toLowerCase());
  if (typeof entry === "string") return entry || shortAddr(gameAddress);
  return entry?.name ?? shortAddr(gameAddress);
}
