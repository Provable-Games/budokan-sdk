// Low-latency broadcasting of the event-driven updates — score submissions and
// prize additions — over the SDK `submissions` / `prizes` WS channels.
//
// The lifecycle poller (commands/watch.ts) handles time-driven phase edges,
// the finalize winner card, and claims drain. The two event-driven updates,
// though, come as they happen — so when the runtime has a global WebSocket
// (Node ≥ 22 / Bun; the bot's deploy target) we subscribe to those channels
// filtered by the watched tournament ids instead of poll-diffing the counts.
// Bursts are debounced into one aggregated card per tournament so a busy
// leaderboard (or a multi-prize create) doesn't flood the channel.
//
// When no global WebSocket exists (e.g. Node 20 dev), the bot keeps the poller's
// count-diffs instead — see TelegramBot.start / tournamentTick.

import {
  createBudokanClient,
  tournamentPageUrl,
  type BudokanClient,
  type WSEventMessage,
} from "@provable-games/budokan-sdk";

import type { Config } from "./config.ts";
import type { Chain } from "./chat-state.ts";
import type { TelegramApi } from "./telegram-api.ts";
import type { TournamentWatchStore } from "./tournament-watch-store.ts";
import { findKnownToken } from "./catalog/tokens.ts";
import { formatTokenAmount } from "./format.ts";
import { isDeadChat } from "./commands/watch.ts";

/** Aggregation window: events arriving within this span post as one card. */
const FLUSH_MS = 8_000;

export class TournamentWatchWs {
  private readonly clients = new Map<Chain, BudokanClient>();
  private readonly unsub = new Map<Chain, () => void>();
  /** Signature (sorted id csv) of each chain's current subscription, for diffing. */
  private readonly sig = new Map<Chain, string>();
  /** Buffered submission counts keyed `chain:tournamentId`, flushed on a timer. */
  private readonly submissions = new Map<string, number>();
  /** Buffered prize descriptions keyed `chain:tournamentId`, flushed on a timer. */
  private readonly prizes = new Map<string, string[]>();
  /** Live WS connection state per chain (from onWsConnectionChange). */
  private readonly connected = new Map<Chain, boolean>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly api: TelegramApi,
    private readonly store: TournamentWatchStore,
  ) {}

  /**
   * (Re)build per-chain subscriptions from the current watch set. Idempotent and
   * cheap — only re-subscribes a chain whose id set actually changed — so it's
   * safe to call on every tick and after every /follow.
   */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    const watched = await this.store.all().catch(() => []);

    const idsByChain = new Map<Chain, string[]>();
    for (const w of watched) {
      const arr = idsByChain.get(w.chain) ?? [];
      arr.push(w.tournamentId);
      idsByChain.set(w.chain, arr);
    }

    // Consider every chain that either has watches now or had a live sub before.
    const chains = new Set<Chain>([...idsByChain.keys(), ...this.sig.keys()]);
    for (const chain of chains) {
      const ids = (idsByChain.get(chain) ?? []).slice().sort();
      const signature = ids.join(",");
      if (signature === (this.sig.get(chain) ?? "")) continue; // no change

      this.unsub.get(chain)?.();
      this.unsub.delete(chain);
      this.sig.delete(chain);
      if (ids.length === 0) continue;

      const off = this.clientFor(chain).subscribe(
        ["submissions", "prizes"],
        (msg) => this.onEvent(chain, msg),
        ids,
      );
      this.unsub.set(chain, off);
      this.sig.set(chain, signature);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const off of this.unsub.values()) off();
    this.unsub.clear();
    this.sig.clear();
    for (const client of this.clients.values()) {
      try {
        client.destroy();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  /**
   * Is this chain's stream live — connected AND actively subscribed? The poller
   * uses this to decide whether it still needs to count-diff events for the
   * chain, so a dropped WS doesn't silently swallow submissions/prizes.
   */
  isStreaming(chain: Chain): boolean {
    return this.sig.has(chain) && this.connected.get(chain) === true;
  }

  private clientFor(chain: Chain): BudokanClient {
    let client = this.clients.get(chain);
    if (!client) {
      client = createBudokanClient({
        chain,
        ...(this.config.apiUrl ? { apiBaseUrl: this.config.apiUrl } : {}),
        ...(this.config.wsUrl ? { wsUrl: this.config.wsUrl } : {}),
      } as Parameters<typeof createBudokanClient>[0]);
      client.onWsConnectionChange((up) => this.connected.set(chain, up));
      client.connect();
      this.clients.set(chain, client);
    }
    return client;
  }

  private onEvent(chain: Chain, msg: WSEventMessage): void {
    // WS payloads are untrusted; read fields defensively (snake or camel).
    const data = msg.data as Record<string, unknown>;
    const raw = data?.tournament_id ?? data?.tournamentId;
    if (raw === undefined || raw === null) return;
    // Normalize the id (a hex felt and a decimal must key the same watch).
    let tid: string;
    try {
      tid = BigInt(raw as string | number).toString();
    } catch {
      return;
    }
    const key = `${chain}:${tid}`;

    if (msg.channel === "submissions") {
      this.submissions.set(key, (this.submissions.get(key) ?? 0) + 1);
      this.scheduleFlush();
    } else if (msg.channel === "prizes") {
      const list = this.prizes.get(key) ?? [];
      list.push(describePrize(chain, data));
      this.prizes.set(key, list);
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private async flush(): Promise<void> {
    const submissions = [...this.submissions.entries()];
    const prizes = [...this.prizes.entries()];
    this.submissions.clear();
    this.prizes.clear();

    // Post concurrently so one slow send doesn't hold up the rest.
    const posts: Array<Promise<void>> = [];
    for (const [key, count] of submissions) {
      posts.push(this.post(key, (name) => `📥 ${count} new score${count === 1 ? "" : "s"} submitted in ${name}.`));
    }
    for (const [key, list] of prizes) {
      posts.push(
        this.post(
          key,
          (name) => `🏆 ${list.length} new prize${list.length === 1 ? "" : "s"} added to ${name}: ${list.join(", ")}`,
        ),
      );
    }
    await Promise.allSettled(posts);
  }

  /** Post a card for a buffered key, re-checking the watch and pruning dead chats. */
  private async post(key: string, text: (name: string) => string): Promise<void> {
    const idx = key.indexOf(":");
    const chain = key.slice(0, idx) as Chain;
    const tid = key.slice(idx + 1);
    // Re-read so a card only posts if it's still followed (picks up announce
    // channel + cached name).
    const w = await this.store.get(chain, tid).catch(() => null);
    if (!w) return;
    const url = tournamentPageUrl(chain, tid);
    try {
      await this.api.sendMessage(w.announceChatId, text(w.name || `Tournament #${tid}`), {
        replyMarkup: { inline_keyboard: [[{ text: "budokan.gg", url }]] },
      });
    } catch (error) {
      if (isDeadChat(error)) await this.store.delete(chain, tid).catch(() => {});
    }
  }
}

/** One-line description of a `prizes`-channel event, with amount + token. */
function describePrize(chain: Chain, data: Record<string, unknown>): string {
  const tokenAddress = str(data.token_address ?? data.tokenAddress);
  const amount = str(data.amount ?? "");
  const tokenId = str(data.token_id ?? data.tokenId ?? "");
  const typeName = str(data.token_type_name ?? data.tokenType ?? "").toLowerCase();

  const isNft = typeName.includes("721") || (!!tokenId && (!amount || amount === "0"));
  if (isNft) return "an NFT";
  if (tokenAddress && amount && amount !== "0") {
    const known = findKnownToken(chain, tokenAddress);
    if (known) return `${formatTokenAmount(amount, known.decimals)} ${known.symbol}`;
    return `${amount} (${tokenAddress.slice(0, 10)}…)`;
  }
  return "a prize";
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}
