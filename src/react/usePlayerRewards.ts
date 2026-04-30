import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  useDenshokanClient,
  useTokens,
} from "@provable-games/denshokan-sdk/react";
import type { Tournament } from "../types/tournament.js";
import type { Prize, RewardClaim } from "../types/prize.js";
import type { PlayerRewards, PlayerPlacement } from "../types/player.js";
import { useBudokanClient } from "./context.js";
import { useTournaments } from "./useTournaments.js";
import { useResetOnClient } from "./useResetOnClient.js";

export interface UsePlayerRewardsResult {
  rewards: PlayerRewards | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Aggregate a player's placement/earnings data across finalized Budokan
 * tournaments they currently hold tokens in.
 *
 * Composition:
 *
 *   denshokan useTokens (current ownership)
 *     ↓ group by contextId (= tournament id)
 *   budokan useTournaments({ tournamentIds })
 *     ↓ filter to finalized
 *   for each finalized tournament (parallel):
 *     budokan getTournamentPrizes        — full prize records
 *     budokan getTournamentRewardClaims  — claim records
 *     denshokan getTokenRanks (bulk)     — final ranks for owned tokens
 *     ↓ filter ranks to paid positions  (max position derived from prizes
 *       + entry-fee distribution_count)
 *
 * Why source ownership from denshokan: PR #243 dropped
 * `registrations.player_address` because the indexed value goes stale on
 * transfer. The contract keys registrations by token_id only, so the only
 * trustworthy answer to "what tournaments has this wallet placed in" is
 * to ask denshokan who currently holds Budokan-minted tokens.
 *
 * Pass `undefined` to skip fetching.
 */
export function usePlayerRewards(
  address: string | undefined,
): UsePlayerRewardsResult {
  const budokan = useBudokanClient();
  const denshokan = useDenshokanClient();
  const budokanAddress = budokan.clientConfig.budokanAddress;

  const [rewards, setRewards] = useState<PlayerRewards | null>(null);
  const [aggregating, setAggregating] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useResetOnClient(budokan, setRewards, setError);

  // 1. Player's currently-owned Budokan tokens.
  const tokensEnabled = !!address && !!budokanAddress;
  const { data: tokensResult, isLoading: tokensLoading } = useTokens(
    tokensEnabled
      ? {
          owner: address,
          minterAddress: budokanAddress,
          limit: 1000,
        }
      : undefined,
  );

  // 2. Group by tournament id (skip creator tokens whose contextId is null).
  const tokensByTournament = useMemo(() => {
    if (!tokensResult?.data) return null;
    const map = new Map<string, string[]>();
    for (const t of tokensResult.data) {
      if (t.contextId == null || !t.tokenId) continue;
      const tid = String(t.contextId);
      let list = map.get(tid);
      if (!list) {
        list = [];
        map.set(tid, list);
      }
      list.push(t.tokenId);
    }
    return map;
  }, [tokensResult]);

  // 3. Tournament data for those ids.
  const tournamentIds = useMemo(
    () => (tokensByTournament ? Array.from(tokensByTournament.keys()) : []),
    [tokensByTournament],
  );
  const { tournaments: tournamentsPage, loading: tournamentsLoading } =
    useTournaments(
      tournamentIds.length > 0
        ? { tournamentIds, limit: 1000 }
        : undefined,
    );

  // 4. Fan out per finalized tournament: prizes + claims + ranks. Once all
  //    resolved, derive placements + aggregate.
  const tournamentIdsKey = tournamentIds.join(",");

  const fetch = useCallback(async () => {
    if (!tokensEnabled) {
      setRewards(null);
      return;
    }
    if (!tokensByTournament) return; // tokens still loading
    if (tokensByTournament.size === 0) {
      setRewards(emptyRewards());
      return;
    }
    if (!tournamentsPage?.data) return; // tournaments still loading

    const now = Math.floor(Date.now() / 1000);
    const finalized = tournamentsPage.data.filter((t) => {
      const sub = Number(t.submissionEndTime ?? 0);
      return sub > 0 && sub <= now;
    });

    if (finalized.length === 0) {
      setRewards(emptyRewards());
      return;
    }

    setAggregating(true);
    setError(null);

    try {
      const perTournament = await Promise.all(
        finalized.map(async (t) => {
          const tid = t.id;
          const tokenIds = tokensByTournament.get(tid) ?? [];
          if (tokenIds.length === 0) return null;

          // Fetch prizes / claims / ranks in parallel — independent calls.
          const [prizes, claimsResult, ranksResult] = await Promise.all([
            budokan.getTournamentPrizes(tid),
            budokan.getTournamentRewardClaims(tid, { limit: 1000 }),
            denshokan.getTokenRanks(tokenIds, {
              contextId: Number(tid),
              minterAddress: budokanAddress!,
            }),
          ]);

          // Max paid position = max across sponsor prize positions / counts
          // + entry-fee distribution count.
          let maxPaid = 0;
          for (const p of prizes) {
            if ((p.payoutPosition ?? 0) > 0) {
              maxPaid = Math.max(maxPaid, p.payoutPosition!);
            }
            if ((p.distributionCount ?? 0) > 0) {
              maxPaid = Math.max(maxPaid, p.distributionCount!);
            }
          }
          const efDistCount = Number(t.entryFee?.distributionCount ?? 0);
          if (efDistCount > 0) maxPaid = Math.max(maxPaid, efDistCount);

          if (maxPaid === 0) return null;

          const placements: PlayerPlacement[] = ranksResult.data
            .filter((r: { rank: number }) => r.rank > 0 && r.rank <= maxPaid)
            .map((r: { tokenId: string; rank: number; score: number | string }) => ({
              tournamentId: tid,
              tokenId: r.tokenId,
              position: r.rank,
              score: String(r.score ?? "0"),
            }));

          if (placements.length === 0) return null;

          return {
            tournament: t,
            prizes,
            rewardClaims: claimsResult.data,
            placements,
          };
        }),
      );

      const valid = perTournament.filter(
        (r): r is NonNullable<typeof r> => r !== null,
      );

      const allPlacements: PlayerPlacement[] = valid.flatMap(
        (r) => r.placements,
      );
      const wins = allPlacements.length;
      const bestPlacement =
        wins > 0 ? Math.min(...allPlacements.map((p) => p.position)) : null;

      const tournamentsList: Tournament[] = valid.map((r) => r.tournament);
      const prizesList: Prize[] = valid.flatMap((r) => r.prizes);
      const rewardClaimsList: RewardClaim[] = valid.flatMap(
        (r) => r.rewardClaims,
      );

      setRewards({
        wins,
        bestPlacement,
        placements: allPlacements,
        tournaments: tournamentsList,
        prizes: prizesList,
        rewardClaims: rewardClaimsList,
      });
    } catch (e) {
      setError(e as Error);
    } finally {
      setAggregating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tokensEnabled,
    tokensByTournament,
    tournamentsPage,
    tournamentIdsKey,
    budokan,
    denshokan,
    budokanAddress,
  ]);

  // Avoid duplicate fan-outs when nothing material changed between renders.
  const lastRunRef = useRef<string>("");
  useEffect(() => {
    if (!tokensEnabled) {
      setRewards(null);
      return;
    }
    if (!tokensByTournament || !tournamentsPage?.data) return;
    const fingerprint = `${address}|${tournamentIdsKey}|${tournamentsPage.data.length}`;
    if (fingerprint === lastRunRef.current) return;
    lastRunRef.current = fingerprint;
    fetch();
  }, [
    address,
    tokensEnabled,
    tokensByTournament,
    tournamentsPage,
    tournamentIdsKey,
    fetch,
  ]);

  const loading =
    (tokensEnabled && (tokensLoading || tournamentsLoading)) || aggregating;

  return { rewards, loading, error, refetch: fetch };
}

function emptyRewards(): PlayerRewards {
  return {
    wins: 0,
    bestPlacement: null,
    placements: [],
    tournaments: [],
    prizes: [],
    rewardClaims: [],
  };
}
