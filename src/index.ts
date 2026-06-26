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
  getRawTokenPrizes,
  isExtensionPrize,
  isMetagameAdaptablePrize,
  isRawExtensionPrize,
  isRawTokenPrize,
  isTokenPrize,
  toMetagameExtensionPrize,
  toMetagamePrize,
  toMetagamePrizes,
  toMetagameTokenPrize,
  toMetagameTokenPrizes,
  tryToMetagamePrize,
  tryToMetagamePrizes,
} from "./utils/prizes.js";
export type {
  MetagameExtensionPrize,
  MetagamePrizeLike,
  MetagameTokenPrize,
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

// Leaderboard score-submission helpers (compute submit_score positions the way
// the Budokan web client does). See src/leaderboard/index.ts.
export { getSubmittableScores, buildSubmitScoreCalls } from "./leaderboard/index.js";
export type { SubmittableScore } from "./leaderboard/index.js";

// Distribution + entry-fee math (pure). Single source of truth for
// per-position payouts and the entry-fee pool split (incl protocol fee).
// See src/distribution/index.ts.
export {
  parseDistribution,
  prizeDistribution,
  distributionPercentages,
  entryFeeSplit,
  entryFeePositionPayout,
  sponsorPrizePayout,
} from "./distribution/index.js";
export type {
  DistributionKind,
  ParsedDistribution,
  EntryFeeSplitInput,
  EntryFeeSplit,
  EntryFeePositionInput,
} from "./distribution/index.js";

// Player reward resolution — which rewards a player can still claim + the
// claim_reward Calls to claim them. See src/rewards/index.ts.
export {
  getClaimableRewards,
  getDistributableRewards,
  buildClaimCalls,
} from "./rewards/index.js";
export type {
  ClaimableReward,
  ClaimableRewardSource,
  GetClaimableRewardsInput,
  GetDistributableRewardsInput,
} from "./rewards/index.js";

// Tournament lifecycle phase derivation (mirrors the contract). See
// src/phase/index.ts.
export { tournamentPhase } from "./phase/index.js";
export type { PhaseInput } from "./phase/index.js";

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
  buildTournamentQualificationProof,
} from "./extensions/index.js";
export type {
  ExtensionPresetKind,
  Erc20BalanceConfig,
  OpusTrovesConfig,
  MerkleConfig,
  TournamentValidatorConfig,
  TournamentRequirementType,
} from "./extensions/index.js";

// 1v1 single-elimination brackets, orchestrated off-chain over ordinary
// leaderboard tournaments (one match = one 2-player tournament). Pure
// state + Call builders; the caller persists state and signs. See
// src/brackets/DESIGN.md.
export {
  createBracket,
  advanceBracket,
  attachMatchTournament,
  pendingMatchCreateCalls,
  bracketEntryCalls,
  nextMatchesFor,
  bracketSummary,
} from "./brackets/index.js";
export type {
  BracketState,
  BracketMatch,
  BracketPlayer,
  MatchStatus,
  MatchScheduleTemplate,
  CreateBracketOptions,
  CreateMatchCall,
  MatchResult,
  MatchReader,
} from "./brackets/index.js";
