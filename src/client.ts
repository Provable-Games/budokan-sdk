import type { BudokanClientConfig } from "./types/config.js";
import type { Tournament, TournamentListParams } from "./types/tournament.js";
import type { LeaderboardEntry } from "./types/leaderboard.js";
import type { Registration } from "./types/registration.js";
import type { Prize } from "./types/prize.js";
import type { PlayerStats, PlayerTournament } from "./types/player.js";
import type { ActivityEvent, ActivityParams, PlatformStats } from "./types/activity.js";
import type { PaginatedResult } from "./types/common.js";
import type { WSChannel, WSEventHandler } from "./types/websocket.js";

import {
  getTournaments as apiGetTournaments,
  getTournament as apiGetTournament,
  getTournamentLeaderboard as apiGetTournamentLeaderboard,
  getTournamentRegistrations as apiGetTournamentRegistrations,
  getTournamentPrizes as apiGetTournamentPrizes,
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
} from "./api/activity.js";
import { WSManager } from "./ws/manager.js";

/**
 * Main client for interacting with the Budokan tournament system.
 *
 * Provides methods for querying tournaments, registrations, leaderboards,
 * prizes, player stats, and activity events. Supports real-time updates
 * via WebSocket subscriptions.
 *
 * @example
 * ```ts
 * const client = new BudokanClient({
 *   apiBaseUrl: "https://budokan-api.provable.games",
 * });
 * const tournaments = await client.getTournaments({ phase: "live" });
 * ```
 */
export class BudokanClient {
  private readonly config: BudokanClientConfig;
  private readonly wsManager: WSManager;

  constructor(config: BudokanClientConfig) {
    this.config = config;
    const wsUrl = config.wsUrl ?? config.apiBaseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    this.wsManager = new WSManager(wsUrl);
  }

  // ---- Configuration ----

  /** Returns the resolved configuration. */
  get clientConfig(): BudokanClientConfig {
    return { ...this.config };
  }

  /** Whether the WebSocket is currently connected. */
  get wsConnected(): boolean {
    return this.wsManager.isConnected;
  }

  // ---- API context ----

  private get apiCtx() {
    return {
      retryAttempts: this.config.retryAttempts,
      retryDelay: this.config.retryDelay,
      timeout: this.config.timeout,
    };
  }

  // ---- Tournament Queries ----

  /**
   * Fetch a paginated list of tournaments with optional filtering.
   */
  async getTournaments(params?: TournamentListParams): Promise<PaginatedResult<Tournament>> {
    return apiGetTournaments(this.config.apiBaseUrl, params, this.apiCtx);
  }

  /**
   * Fetch a single tournament by its ID.
   */
  async getTournament(tournamentId: string): Promise<Tournament> {
    return apiGetTournament(this.config.apiBaseUrl, tournamentId, this.apiCtx);
  }

  /**
   * Fetch the leaderboard for a tournament.
   */
  async getTournamentLeaderboard(tournamentId: string): Promise<LeaderboardEntry[]> {
    return apiGetTournamentLeaderboard(this.config.apiBaseUrl, tournamentId, this.apiCtx);
  }

  /**
   * Fetch registrations for a tournament.
   */
  async getTournamentRegistrations(
    tournamentId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<PaginatedResult<Registration>> {
    return apiGetTournamentRegistrations(this.config.apiBaseUrl, tournamentId, params, this.apiCtx);
  }

  /**
   * Fetch prizes for a tournament.
   */
  async getTournamentPrizes(tournamentId: string): Promise<Prize[]> {
    return apiGetTournamentPrizes(this.config.apiBaseUrl, tournamentId, this.apiCtx);
  }

  // ---- Player Queries ----

  /**
   * Fetch tournaments that a player has registered for.
   */
  async getPlayerTournaments(
    address: string,
    params?: { limit?: number; offset?: number },
  ): Promise<PaginatedResult<PlayerTournament>> {
    return apiGetPlayerTournaments(this.config.apiBaseUrl, address, params, this.apiCtx);
  }

  /**
   * Fetch stats for a player.
   */
  async getPlayerStats(address: string): Promise<PlayerStats> {
    return apiGetPlayerStats(this.config.apiBaseUrl, address, this.apiCtx);
  }

  // ---- Game Queries ----

  /**
   * Fetch tournaments for a specific game.
   */
  async getGameTournaments(
    gameAddress: string,
    params?: Omit<TournamentListParams, "gameAddress">,
  ): Promise<PaginatedResult<Tournament>> {
    return apiGetGameTournaments(this.config.apiBaseUrl, gameAddress, params, this.apiCtx);
  }

  /**
   * Fetch tournament stats for a specific game.
   */
  async getGameStats(gameAddress: string): Promise<PlatformStats> {
    return apiGetGameStats(this.config.apiBaseUrl, gameAddress, this.apiCtx);
  }

  // ---- Activity Queries ----

  /**
   * Fetch activity events with optional filtering.
   */
  async getActivity(params?: ActivityParams): Promise<PaginatedResult<ActivityEvent>> {
    return apiGetActivity(this.config.apiBaseUrl, params, this.apiCtx);
  }

  /**
   * Fetch platform-wide activity stats.
   */
  async getActivityStats(): Promise<PlatformStats> {
    return apiGetActivityStats(this.config.apiBaseUrl, this.apiCtx);
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
