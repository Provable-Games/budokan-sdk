import type { RpcProvider, Contract, Abi } from "starknet";
import type { BudokanClientConfig } from "./types/config.js";
import type { Tournament, TournamentListParams } from "./types/tournament.js";
import type { LeaderboardEntry } from "./types/leaderboard.js";
import type { Registration } from "./types/registration.js";
import type { Prize, RewardClaim, RewardClaimSummary, PrizeAggregation } from "./types/prize.js";
import type { PlayerStats, PlayerTournament, PlayerTournamentParams } from "./types/player.js";
import type { ActivityEvent, ActivityParams, PlatformStats, PrizeStats } from "./types/activity.js";
import type { QualificationEntry } from "./types/tournament.js";
import type { PaginatedResult } from "./types/common.js";
import type { WSChannel, WSEventHandler } from "./types/websocket.js";
import type { ConnectionStatusState } from "./datasource/health.js";

import {
  getTournaments as apiGetTournaments,
  getTournament as apiGetTournament,
  getTournamentLeaderboard as apiGetTournamentLeaderboard,
  getTournamentRegistrations as apiGetTournamentRegistrations,
  getTournamentPrizes as apiGetTournamentPrizes,
  getTournamentRewardClaims as apiGetTournamentRewardClaims,
  getTournamentRewardClaimsSummary as apiGetTournamentRewardClaimsSummary,
  getTournamentQualifications as apiGetTournamentQualifications,
  getTournamentPrizeAggregation as apiGetTournamentPrizeAggregation,
} from "./api/tournaments.js";
import {
  getPlayerTournaments as apiGetPlayerTournaments,
  getPlayerStats as apiGetPlayerStats,
} from "./api/players.js";
import {
  getGameTournaments as apiGetGameTournaments,
  getGameStats as apiGetGameStats,
} from "./api/games.js";
import {
  getActivity as apiGetActivity,
  getActivityStats as apiGetActivityStats,
  getPrizeStats as apiGetPrizeStats,
} from "./api/activity.js";
import { WSManager } from "./ws/manager.js";
import { getChainConfig } from "./chains/constants.js";
import { ConnectionStatus } from "./datasource/health.js";
import { withFallback } from "./datasource/resolver.js";
import { RpcError } from "./errors/index.js";
import { createProvider, createContract } from "./rpc/provider.js";
import {
  viewerTournaments,
  viewerTournamentsByGame,
  viewerTournamentsByCreator,
  viewerTournamentsByPhase,
  viewerTournamentDetail,
  viewerTournamentsBatch,
  viewerRegistrations,
  viewerRegistrationsByOwner,
  viewerRegistrationsByTokenIds,
  viewerLeaderboard,
  viewerPrizes,
  viewerRewardClaims,
  viewerPlayerTournaments,
} from "./rpc/viewer.js";

import viewerAbi from "./rpc/abis/budokanViewer.json";

/** Resolved config with all defaults applied */
interface ResolvedConfig extends BudokanClientConfig {
  rpcUrl: string;
  viewerAddress: string;
  budokanAddress: string;
}

/**
 * Main client for interacting with the Budokan tournament system.
 *
 * Provides methods for querying tournaments, registrations, leaderboards,
 * prizes, player stats, and activity events. Supports real-time updates
 * via WebSocket subscriptions and automatic RPC fallback when the API is
 * unavailable.
 *
 * @example
 * ```ts
 * // API-only (default, backward compatible)
 * const client = new BudokanClient({
 *   apiBaseUrl: "https://budokan-api.provable.games",
 * });
 *
 * // With RPC fallback
 * const client = new BudokanClient({
 *   chain: "mainnet",
 *   apiBaseUrl: "https://budokan-api.provable.games",
 *   viewerAddress: "0x...",
 * });
 *
 * // RPC-only (bypass API entirely)
 * const client = new BudokanClient({
 *   primarySource: "rpc",
 *   rpcUrl: "https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_10",
 *   viewerAddress: "0x...",
 * });
 * ```
 */
export class BudokanClient {
  private readonly resolvedConfig: ResolvedConfig;
  private readonly wsManager: WSManager;
  private readonly connectionStatus: ConnectionStatus;
  private cachedProvider: RpcProvider | null = null;
  private cachedViewerContract: Contract | null = null;

  constructor(config: BudokanClientConfig) {
    // Merge user config with chain defaults
    const chainConfig = config.chain ? getChainConfig(config.chain) : undefined;
    this.resolvedConfig = {
      ...config,
      apiBaseUrl: config.apiBaseUrl ?? chainConfig?.apiBaseUrl ?? "",
      rpcUrl: config.rpcUrl ?? chainConfig?.rpcUrl ?? "",
      viewerAddress: config.viewerAddress ?? chainConfig?.viewerAddress ?? "",
      budokanAddress: config.budokanAddress ?? chainConfig?.budokanAddress ?? "",
    };

    const wsUrl = config.wsUrl ?? chainConfig?.wsUrl
      ?? this.resolvedConfig.apiBaseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    this.wsManager = new WSManager(wsUrl);

    this.connectionStatus = new ConnectionStatus(
      this.resolvedConfig.apiBaseUrl,
      this.resolvedConfig.rpcUrl,
      config.health,
    );

    // Start health monitoring if both sources are configured
    if (this.resolvedConfig.apiBaseUrl && this.resolvedConfig.rpcUrl) {
      this.connectionStatus.startMonitoring();
    }
  }

  // ---- Configuration ----

  /** Returns the resolved configuration. */
  get clientConfig(): BudokanClientConfig {
    return { ...this.resolvedConfig };
  }

  /** Whether the WebSocket is currently connected. */
  get wsConnected(): boolean {
    return this.wsManager.isConnected;
  }

  // ---- Connection status ----

  /** Returns the current connection status (API, RPC, mode). */
  getConnectionStatus(): ConnectionStatusState {
    return this.connectionStatus.getStatus();
  }

  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onConnectionStatusChange(listener: (status: ConnectionStatusState) => void): () => void {
    return this.connectionStatus.subscribe(listener);
  }

  // ---- Lazy RPC getters ----

  private async getProvider(): Promise<RpcProvider> {
    if (this.cachedProvider) return this.cachedProvider;
    if (!this.resolvedConfig.rpcUrl) {
      throw new RpcError("No rpcUrl configured");
    }
    if (this.resolvedConfig.provider) {
      this.cachedProvider = this.resolvedConfig.provider;
      return this.cachedProvider;
    }
    this.cachedProvider = await createProvider(
      this.resolvedConfig.rpcUrl,
      this.resolvedConfig.rpcHeaders,
    );
    return this.cachedProvider;
  }

  private async getViewerContract(): Promise<Contract> {
    if (this.cachedViewerContract) return this.cachedViewerContract;
    if (!this.resolvedConfig.viewerAddress) {
      throw new RpcError("No viewerAddress configured. Set viewerAddress in config or use a chain preset with a deployed viewer contract.");
    }
    const provider = await this.getProvider();
    this.cachedViewerContract = await createContract(
      viewerAbi as Abi,
      this.resolvedConfig.viewerAddress,
      provider,
    );
    return this.cachedViewerContract;
  }

  // ---- API context ----

  private get apiCtx() {
    return {
      retryAttempts: this.resolvedConfig.retryAttempts,
      retryDelay: this.resolvedConfig.retryDelay,
      timeout: this.resolvedConfig.timeout,
    };
  }

  // ---- Tournament Queries ----

  /**
   * Fetch a paginated list of tournaments with optional filtering.
   * Supports RPC fallback when API is unavailable.
   */
  async getTournaments(params?: TournamentListParams): Promise<PaginatedResult<Tournament>> {
    const rpcFallback = async (): Promise<PaginatedResult<Tournament>> => {
      const contract = await this.getViewerContract();
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 20;

      // Choose the appropriate viewer filter function
      let filterResult: { tournamentIds: string[]; total: number };
      if (params?.phase) {
        filterResult = await viewerTournamentsByPhase(contract, params.phase, offset, limit);
      } else if (params?.gameAddress) {
        filterResult = await viewerTournamentsByGame(contract, params.gameAddress, offset, limit);
      } else if (params?.creator) {
        filterResult = await viewerTournamentsByCreator(contract, params.creator, offset, limit);
      } else {
        filterResult = await viewerTournaments(contract, offset, limit);
      }

      // Batch-fetch full tournament data for the returned IDs
      let data: Tournament[] = [];
      if (filterResult.tournamentIds.length > 0) {
        data = await viewerTournamentsBatch(contract, filterResult.tournamentIds);

        // Fetch prize aggregation if requested
        if (params?.includePrizeSummary) {
          const prizePromises = data.map((t) =>
            viewerPrizes(contract, t.id).catch(() => [] as Prize[]),
          );
          const allPrizes = await Promise.all(prizePromises);
          data = data.map((t, i) => {
            const prizes = allPrizes[i];
            if (prizes.length === 0) return t;
            // Build aggregation by token
            const tokenMap = new Map<string, { tokenAddress: string; tokenType: string; totalAmount: bigint; nftCount: number }>();
            for (const p of prizes) {
              const key = p.tokenAddress;
              const existing = tokenMap.get(key);
              if (existing) {
                existing.totalAmount += BigInt(p.amount ?? "0");
                if (p.tokenType === "erc721") existing.nftCount += 1;
              } else {
                tokenMap.set(key, {
                  tokenAddress: p.tokenAddress,
                  tokenType: p.tokenType,
                  totalAmount: BigInt(p.amount ?? "0"),
                  nftCount: p.tokenType === "erc721" ? 1 : 0,
                });
              }
            }
            return {
              ...t,
              prizeAggregation: Array.from(tokenMap.values()).map((v) => ({
                tokenAddress: v.tokenAddress,
                tokenType: v.tokenType,
                totalAmount: v.totalAmount.toString(),
                nftCount: v.nftCount,
              })),
            };
          });
        }
      }

      return { data, total: filterResult.total, limit, offset };
    };

    if (this.resolvedConfig.primarySource === "rpc") {
      return rpcFallback();
    }

    return withFallback(
      () => apiGetTournaments(this.resolvedConfig.apiBaseUrl, params, this.apiCtx),
      rpcFallback,
      this.connectionStatus,
    );
  }

  /**
   * Fetch a single tournament by its ID.
   * Supports RPC fallback when API is unavailable.
   */
  async getTournament(tournamentId: string): Promise<Tournament | null> {
    const rpcFallback = async () => {
      const contract = await this.getViewerContract();
      return viewerTournamentDetail(contract, tournamentId);
    };

    if (this.resolvedConfig.primarySource === "rpc") {
      return rpcFallback();
    }

    try {
      return await apiGetTournament(this.resolvedConfig.apiBaseUrl, tournamentId, this.apiCtx);
    } catch {
      // API 404 or network error — try RPC fallback
      try {
        this.connectionStatus.markApiUnavailable();
        return await rpcFallback();
      } catch {
        return null;
      }
    }
  }

  /**
   * Fetch the leaderboard for a tournament.
   * Supports RPC fallback when API is unavailable.
   */
  async getTournamentLeaderboard(tournamentId: string): Promise<LeaderboardEntry[]> {
    const rpcFallback = async () => {
      const contract = await this.getViewerContract();
      // Fetch a large page; on-chain leaderboards are typically small
      return viewerLeaderboard(contract, tournamentId, 0, 1000);
    };

    if (this.resolvedConfig.primarySource === "rpc") {
      return rpcFallback();
    }

    return withFallback(
      () => apiGetTournamentLeaderboard(this.resolvedConfig.apiBaseUrl, tournamentId, this.apiCtx),
      rpcFallback,
      this.connectionStatus,
    );
  }

  /**
   * Fetch registrations for a tournament.
   * Supports RPC fallback when API is unavailable.
   * Note: In RPC mode, `playerAddress` and `gameAddress` fields will be empty strings,
   * and filter params (`playerAddress`, `gameTokenIds`, `hasSubmitted`, `isBanned`)
   * are applied via on-chain viewer functions where supported.
   */
  async getTournamentRegistrations(
    tournamentId: string,
    params?: { playerAddress?: string; gameTokenIds?: string[]; hasSubmitted?: boolean; isBanned?: boolean; limit?: number; offset?: number },
  ): Promise<PaginatedResult<Registration>> {
    const rpcFallback = async () => {
      const contract = await this.getViewerContract();
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 20;
      if (params?.playerAddress) {
        return viewerRegistrationsByOwner(contract, tournamentId, params.playerAddress, offset, limit);
      }
      if (params?.gameTokenIds?.length) {
        return viewerRegistrationsByTokenIds(contract, tournamentId, params.gameTokenIds, offset, limit);
      }
      return viewerRegistrations(contract, tournamentId, offset, limit);
    };

    if (this.resolvedConfig.primarySource === "rpc") {
      return rpcFallback();
    }

    return withFallback(
      () => apiGetTournamentRegistrations(this.resolvedConfig.apiBaseUrl, tournamentId, params, this.apiCtx),
      rpcFallback,
      this.connectionStatus,
    );
  }

  /**
   * Fetch prizes for a tournament.
   * Supports RPC fallback when API is unavailable.
   */
  async getTournamentPrizes(tournamentId: string): Promise<Prize[]> {
    const rpcFallback = async () => {
      const contract = await this.getViewerContract();
      return viewerPrizes(contract, tournamentId);
    };

    if (this.resolvedConfig.primarySource === "rpc") {
      return rpcFallback();
    }

    return withFallback(
      () => apiGetTournamentPrizes(this.resolvedConfig.apiBaseUrl, tournamentId, this.apiCtx),
      rpcFallback,
      this.connectionStatus,
    );
  }

  // ---- Player Queries (API-only, no on-chain equivalent) ----

  /**
   * Fetch tournaments that a player has registered for.
   * Supports RPC fallback via viewer contract.
   */
  async getPlayerTournaments(
    address: string,
    params?: PlayerTournamentParams,
  ): Promise<PaginatedResult<PlayerTournament>> {
    const rpcFallback = async (): Promise<PaginatedResult<PlayerTournament>> => {
      const contract = await this.getViewerContract();
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 20;
      const filterResult = await viewerPlayerTournaments(contract, address, offset, limit);

      let data: PlayerTournament[] = [];
      if (filterResult.tournamentIds.length > 0) {
        const tournaments = await viewerTournamentsBatch(contract, filterResult.tournamentIds);
        data = tournaments.map((t) => ({
          ...t,
          tournamentId: t.id,
        })) as unknown as PlayerTournament[];
      }

      return { data, total: filterResult.total, limit, offset };
    };

    if (this.resolvedConfig.primarySource === "rpc") {
      return rpcFallback();
    }

    return withFallback(
      () => apiGetPlayerTournaments(this.resolvedConfig.apiBaseUrl, address, params, this.apiCtx),
      rpcFallback,
      this.connectionStatus,
    );
  }

  /**
   * Fetch stats for a player.
   * API-only — no RPC fallback available.
   */
  async getPlayerStats(address: string): Promise<PlayerStats> {
    return apiGetPlayerStats(this.resolvedConfig.apiBaseUrl, address, this.apiCtx);
  }

  // ---- Game Queries ----

  /**
   * Fetch tournaments for a specific game.
   * Supports RPC fallback when API is unavailable.
   */
  async getGameTournaments(
    gameAddress: string,
    params?: Omit<TournamentListParams, "gameAddress">,
  ): Promise<PaginatedResult<Tournament>> {
    const rpcFallback = async (): Promise<PaginatedResult<Tournament>> => {
      const contract = await this.getViewerContract();
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 20;
      const filterResult = await viewerTournamentsByGame(contract, gameAddress, offset, limit);

      let data: Tournament[] = [];
      if (filterResult.tournamentIds.length > 0) {
        data = await viewerTournamentsBatch(contract, filterResult.tournamentIds);
      }

      return { data, total: filterResult.total, limit, offset };
    };

    if (this.resolvedConfig.primarySource === "rpc") {
      return rpcFallback();
    }

    return withFallback(
      () => apiGetGameTournaments(this.resolvedConfig.apiBaseUrl, gameAddress, params, this.apiCtx),
      rpcFallback,
      this.connectionStatus,
    );
  }

  /**
   * Fetch tournament stats for a specific game.
   * API-only — no RPC fallback available.
   */
  async getGameStats(gameAddress: string): Promise<PlatformStats> {
    return apiGetGameStats(this.resolvedConfig.apiBaseUrl, gameAddress, this.apiCtx);
  }

  // ---- Reward Claims & Qualifications ----

  /**
   * Fetch reward claims for a tournament.
   * Supports RPC fallback via viewer contract.
   */
  async getTournamentRewardClaims(
    tournamentId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<PaginatedResult<RewardClaim>> {
    const rpcFallback = async (): Promise<PaginatedResult<RewardClaim>> => {
      const contract = await this.getViewerContract();
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 100;
      const result = await viewerRewardClaims(contract, tournamentId, offset, limit);
      const data: RewardClaim[] = result.claims.map((c) => ({
        tournamentId,
        rewardType: c.rewardType as RewardClaim["rewardType"],
        claimed: c.claimed,
      }));
      return { data, total: result.total, limit, offset };
    };

    if (this.resolvedConfig.primarySource === "rpc") {
      return rpcFallback();
    }

    return withFallback(
      () => apiGetTournamentRewardClaims(this.resolvedConfig.apiBaseUrl, tournamentId, params, this.apiCtx),
      rpcFallback,
      this.connectionStatus,
    );
  }

  /**
   * Fetch reward claims summary for a tournament.
   * Supports RPC fallback via viewer contract.
   */
  async getTournamentRewardClaimsSummary(tournamentId: string): Promise<RewardClaimSummary> {
    const rpcFallback = async (): Promise<RewardClaimSummary> => {
      const contract = await this.getViewerContract();
      const result = await viewerRewardClaims(contract, tournamentId, 0, 0);
      return {
        totalPrizes: result.total,
        totalClaimed: result.totalClaimed,
        totalUnclaimed: result.totalUnclaimed,
      };
    };

    if (this.resolvedConfig.primarySource === "rpc") {
      return rpcFallback();
    }

    return withFallback(
      () => apiGetTournamentRewardClaimsSummary(this.resolvedConfig.apiBaseUrl, tournamentId, this.apiCtx),
      rpcFallback,
      this.connectionStatus,
    );
  }

  /**
   * Fetch qualifications for a tournament.
   * API-only -- no RPC fallback available.
   */
  async getTournamentQualifications(
    tournamentId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<PaginatedResult<QualificationEntry>> {
    return apiGetTournamentQualifications(this.resolvedConfig.apiBaseUrl, tournamentId, params, this.apiCtx);
  }

  /**
   * Fetch prize aggregation for a tournament.
   * API-only -- no RPC fallback available.
   */
  async getTournamentPrizeAggregation(tournamentId: string): Promise<PrizeAggregation[]> {
    return apiGetTournamentPrizeAggregation(this.resolvedConfig.apiBaseUrl, tournamentId, this.apiCtx);
  }

  // ---- Activity Queries (API-only, activity is indexed) ----

  /**
   * Fetch activity events with optional filtering.
   * API-only — no RPC fallback available.
   */
  async getActivity(params?: ActivityParams): Promise<PaginatedResult<ActivityEvent>> {
    return apiGetActivity(this.resolvedConfig.apiBaseUrl, params, this.apiCtx);
  }

  /**
   * Fetch platform-wide activity stats.
   * API-only — no RPC fallback available.
   */
  async getActivityStats(): Promise<PlatformStats> {
    return apiGetActivityStats(this.resolvedConfig.apiBaseUrl, this.apiCtx);
  }

  /**
   * Fetch platform-wide prize stats.
   * API-only — no RPC fallback available.
   */
  async getPrizeStats(): Promise<PrizeStats> {
    return apiGetPrizeStats(this.resolvedConfig.apiBaseUrl, this.apiCtx);
  }

  // ---- WebSocket ----

  /**
   * Open a WebSocket connection for real-time updates.
   */
  connect(): void {
    this.wsManager.connect();
  }

  /**
   * Close the WebSocket connection.
   */
  disconnect(): void {
    this.wsManager.disconnect();
  }

  /**
   * Stop health monitoring and close all connections.
   */
  destroy(): void {
    this.connectionStatus.destroy();
    this.wsManager.disconnect();
  }

  /**
   * Subscribe to WebSocket channels with optional tournament filtering.
   * Returns an unsubscribe function.
   */
  subscribe(
    channels: WSChannel[],
    handler: WSEventHandler,
    tournamentIds?: string[],
  ): () => void {
    return this.wsManager.subscribe({ channels, tournamentIds }, handler);
  }

  /**
   * Register a listener for WebSocket connection state changes.
   * Returns an unsubscribe function.
   */
  onWsConnectionChange(listener: (connected: boolean) => void): () => void {
    return this.wsManager.onConnectionChange(listener);
  }
}

/**
 * Factory function for creating a BudokanClient instance.
 */
export function createBudokanClient(config: BudokanClientConfig): BudokanClient {
  return new BudokanClient(config);
}
