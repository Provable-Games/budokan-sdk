// Shared multicall batching for the claim/distribute flows.
//
// A claim/distribute can resolve to many claim_reward calls. Firing them all in
// one account.execute risks blowing past the per-tx call limit or the
// paymaster's sponsorship bounds, so we split into batches and await acceptance
// between them (the WalletAccount manages nonce off the accepted tx, so without
// the wait batch N+1 can race batch N's nonce).

import type { ExecutingAccount } from "./controller-account.ts";

export interface Call {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}

export const DEFAULT_BATCH_SIZE = 25;

export interface BatchProgress {
  /** 1-indexed batch just submitted. */
  index: number;
  total: number;
  /** Calls completed so far. */
  done: number;
}

export interface BatchOutcome {
  hashes: string[];
  /** Calls successfully submitted (and accepted, except possibly the last). */
  done: number;
  /** Set when a batch threw; `done` reflects progress before it. */
  error?: unknown;
}

/**
 * Execute `calls` in batches of `batchSize`, awaiting acceptance between
 * batches. Stops at the first failing batch and returns how far it got, so the
 * caller can report partial progress.
 */
export async function executeBatched(
  account: ExecutingAccount,
  calls: Call[],
  batchSize: number = DEFAULT_BATCH_SIZE,
  onProgress?: (p: BatchProgress) => Promise<void> | void,
): Promise<BatchOutcome> {
  const batches: Call[][] = [];
  for (let i = 0; i < calls.length; i += batchSize) {
    batches.push(calls.slice(i, i + batchSize));
  }

  const hashes: string[] = [];
  let done = 0;
  for (let i = 0; i < batches.length; i++) {
    let tx: { transaction_hash: string };
    try {
      tx = await account.execute(batches[i]!);
    } catch (error) {
      return { hashes, done, error };
    }
    hashes.push(tx.transaction_hash);
    done += batches[i]!.length;
    // Wait for acceptance before the next batch so the nonce doesn't race.
    if (i < batches.length - 1) {
      await account.waitForTransaction(tx.transaction_hash);
    }
    if (onProgress) await onProgress({ index: i + 1, total: batches.length, done });
  }
  return { hashes, done };
}
