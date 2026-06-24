// Fetch ALL reward-claim records for a tournament, paginating past the API's
// per-page cap. /claim and /distribute filter already-claimed rewards against
// these; stopping at the first page would let a large tournament (>1 page of
// claims) re-include an already-claimed reward and revert mid-batch.

import type { BudokanClient, RewardClaim } from "@provable-games/budokan-sdk";

const PAGE = 1000;

export async function fetchAllRewardClaims(
  client: BudokanClient,
  tournamentId: string,
): Promise<RewardClaim[]> {
  const all: RewardClaim[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.getTournamentRewardClaims(tournamentId, { limit: PAGE, offset });
    all.push(...page.data);
    // Last page when the server returns fewer than a full page, or we've
    // collected the reported total.
    if (page.data.length < PAGE) break;
    if (typeof page.total === "number" && all.length >= page.total) break;
  }
  return all;
}
