// Client
export { BudokanClient, createBudokanClient } from "./client.js";

// Types
export type {
  BudokanClientConfig,
  Tournament,
  Schedule,
  GameConfig,
  EntryFee,
  LeaderboardConfig,
  Phase,
  TournamentListParams,
  Registration,
  LeaderboardEntry,
  Prize,
  RewardClaim,
  PlayerStats,
  PlayerTournament,
  ActivityEvent,
  ActivityParams,
  PlatformStats,
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
} from "./errors/index.js";

// API functions
export {
  getTournaments,
  getTournament,
  getTournamentLeaderboard,
  getTournamentRegistrations,
  getTournamentPrizes,
} from "./api/tournaments.js";
export { getPlayerTournaments, getPlayerStats } from "./api/players.js";
export { getGameTournaments, getGameStats } from "./api/games.js";
export { getActivity, getActivityStats } from "./api/activity.js";

// WebSocket
export { WSManager } from "./ws/manager.js";

// Utils
export { normalizeAddress } from "./utils/address.js";
export { snakeToCamel, camelToSnake } from "./utils/mappers.js";
export { withRetry } from "./utils/retry.js";

// Chains
export { CHAINS, getChainConfig } from "./chains/constants.js";
export type { ChainConfig } from "./chains/constants.js";
