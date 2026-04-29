// Client
export { BudokanClient, createBudokanClient } from "./client.js";

// Types
export type {
  BudokanClientConfig,
  DataSource,
  Tournament,
  Schedule,
  GameConfig,
  EntryFee,
  LeaderboardConfig,
  Phase,
  TournamentListParams,
  QualificationEntry,
  Registration,
  LeaderboardEntry,
  Prize,
  RewardClaim,
  PrizeAggregation,
  RewardClaimSummary,
  ActivityEvent,
  ActivityParams,
  PlatformStats,
  PrizeStats,
  PaginatedResult,
  WSChannel,
  WSSubscribeMessage,
  WSUnsubscribeMessage,
  WSEventMessage,
  WSMessage,
  WSSubscribeOptions,
  WSEventHandler,
} from "./types/index.js";

// Errors
export {
  BudokanError,
  BudokanApiError,
  BudokanTimeoutError,
  BudokanConnectionError,
  TournamentNotFoundError,
  RpcError,
  DataSourceError,
} from "./errors/index.js";

// Datasource
export { ConnectionStatus } from "./datasource/health.js";
export type { ConnectionMode, ConnectionStatusState } from "./datasource/health.js";

// API functions
export {
  getTournaments,
  getTournament,
  getTournamentRegistrations,
  getTournamentPrizes,
  getTournamentRewardClaims,
  getTournamentRewardClaimsSummary,
  getTournamentQualifications,
  getTournamentPrizeAggregation,
} from "./api/tournaments.js";
export { getGameTournaments, getGameStats } from "./api/games.js";
export { getActivity, getActivityStats, getPrizeStats } from "./api/activity.js";

// WebSocket
export { WSManager } from "./ws/manager.js";

// Utils
export { normalizeAddress } from "./utils/address.js";
export { snakeToCamel, camelToSnake } from "./utils/mappers.js";
export { withRetry } from "./utils/retry.js";

// Chains
export { CHAINS, getChainConfig } from "./chains/constants.js";
export type { ChainConfig } from "./chains/constants.js";
