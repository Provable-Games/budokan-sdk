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
  Erc20Prize,
  Erc721Prize,
  ExtensionPrize,
  Prize,
  TokenPrize,
  RewardClaim,
  PrizeAggregation,
  RewardClaimSummary,
  PlatformStats,
  PrizeStats,
  PlayerRewards,
  PlayerPlacement,
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
export { getActivityStats, getPrizeStats } from "./api/activity.js";

// WebSocket
export { WSManager } from "./ws/manager.js";

// Utils
export { normalizeAddress } from "./utils/address.js";
export { snakeToCamel, camelToSnake } from "./utils/mappers.js";
export { withRetry } from "./utils/retry.js";
export {
  getTokenPrizes,
  isExtensionPrize,
  isTokenPrize,
  toMetagameExtensionPrize,
  toMetagamePrize,
  toMetagamePrizes,
  toMetagameTokenPrize,
  toMetagameTokenPrizes,
} from "./utils/prizes.js";

// Chains
export {
  CHAINS,
  getChainConfig,
  explorerBaseUrl,
  explorerTxUrl,
  explorerAddressUrl,
  tournamentPageUrl,
} from "./chains/constants.js";
export type { ChainConfig } from "./chains/constants.js";

// Game whitelist + per-game UX metadata. The denshokan registry is the
// source of truth for which games exist; this whitelist is the subset
// we recommend / support, plus extra metadata that doesn't live on chain.
export {
  getWhitelistedGames,
  findWhitelistedGame,
  isGameWhitelisted,
  getGameDefaults,
} from "./games/whitelist.js";
export type {
  WhitelistedGame,
  WhitelistChain,
  GameDefaults,
} from "./games/whitelist.js";

// Calldata builders for Budokan's on-chain entrypoints. Use these from
// any integration (Discord bot, CLI, agent code, …) that needs to drive
// the same contract — they encode Cairo enums and Options correctly and
// keep encoding gotchas in one place. See src/calldata/index.ts.
export {
  buildCreateTournamentCall,
  buildEnterTournamentCall,
  buildSubmitScoreCall,
  buildClaimRewardCall,
  buildAddPrizeCall,
  buildErc20ApproveCall,
  parseTournamentIdFromReceipt,
} from "./calldata/index.js";
export type {
  Call,
  CreateTournamentArgs,
  EnterTournamentArgs,
  AddPrizeArgs,
  PrizeSpec,
  TokenTypeSpec,
  EntryFeeArgs,
  EntryRequirementArgs,
  EntryRequirementSpec,
  DistributionSpec,
  RewardType,
  ReceiptWithEvents,
} from "./calldata/index.js";

// Entry-requirement validator extension presets — address lookup +
// `Span<felt252>` config builders for the four common validators
// (merkle, erc20Balance, opusTroves, tournament). See
// src/extensions/index.ts.
export {
  extensionAddressFor,
  u256ToLowHigh,
  buildErc20BalanceConfig,
  buildOpusTrovesConfig,
  buildMerkleConfig,
  buildTournamentValidatorConfig,
} from "./extensions/index.js";
export type {
  ExtensionPresetKind,
  Erc20BalanceConfig,
  OpusTrovesConfig,
  MerkleConfig,
  TournamentValidatorConfig,
  TournamentRequirementType,
} from "./extensions/index.js";
