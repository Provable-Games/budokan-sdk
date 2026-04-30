// Provider & context
export { BudokanProvider, useBudokanClient } from "./context.js";
export type { BudokanProviderProps } from "./context.js";

// Data hooks
export { useTournaments, useTournament } from "./useTournaments.js";
export type { UseTournamentsResult, UseTournamentResult } from "./useTournaments.js";
export { useTournamentCount } from "./useTournamentCount.js";
export type { UseTournamentCountResult } from "./useTournamentCount.js";
export { useLeaderboard } from "./useLeaderboard.js";
export type { UseLeaderboardResult } from "./useLeaderboard.js";
export { useRegistrations } from "./useRegistrations.js";
export type { UseRegistrationsResult } from "./useRegistrations.js";
export {
  useTournamentsByOwner,
  useTournamentsByOwnerCount,
  useRegistrationsByOwner,
} from "./useByOwner.js";

// Reward & Prize hooks
export { useRewardClaims, useRewardClaimsSummary } from "./useRewardClaims.js";
export type { UseRewardClaimsResult, UseRewardClaimsSummaryResult } from "./useRewardClaims.js";
export { usePrizes, usePrizeStats } from "./usePrizes.js";
export type { UsePrizesResult, UsePrizeStatsResult } from "./usePrizes.js";
export { usePrizeAggregation } from "./usePrizeAggregation.js";
export type { UsePrizeAggregationResult } from "./usePrizeAggregation.js";
export { useQualifications } from "./useQualifications.js";
export type { UseQualificationsResult } from "./useQualifications.js";

// Activity hooks
export { useActivityStats } from "./useActivityStats.js";
export type { UseActivityStatsResult } from "./useActivityStats.js";

// Player hooks
export { usePlayerRewards } from "./usePlayerRewards.js";
export type { UsePlayerRewardsResult } from "./usePlayerRewards.js";

// WebSocket hooks
export { useSubscription } from "./useSubscription.js";
export type { UseSubscriptionResult } from "./useSubscription.js";
export { useConnectionStatus } from "./useConnectionStatus.js";
