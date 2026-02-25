import { T as Tournament, L as LeaderboardEntry, P as Prize, a as PaginatedResult, R as Registration, b as TournamentListParams, c as PlayerStats, d as PlayerTournament, e as PlatformStats, A as ActivityParams, f as ActivityEvent, W as WSSubscribeOptions, g as WSEventHandler } from './client-Bl4fuXK0.js';
export { B as BudokanClient, h as BudokanClientConfig, E as EntryFee, G as GameConfig, i as LeaderboardConfig, j as Phase, k as RewardClaim, S as Schedule, l as WSChannel, m as WSEventMessage, n as WSMessage, o as WSSubscribeMessage, p as WSUnsubscribeMessage, q as createBudokanClient } from './client-Bl4fuXK0.js';

declare class BudokanError extends Error {
    constructor(message: string);
}
declare class BudokanApiError extends BudokanError {
    readonly status: number;
    readonly statusText: string;
    constructor(message: string, status: number, statusText?: string);
}
declare class BudokanTimeoutError extends BudokanError {
    constructor(message?: string);
}
declare class BudokanConnectionError extends BudokanError {
    constructor(message?: string);
}
declare class TournamentNotFoundError extends BudokanError {
    readonly tournamentId: string;
    constructor(tournamentId: string);
}

interface ApiContext$3 {
    retryAttempts?: number;
    retryDelay?: number;
    timeout?: number;
}
/**
 * Fetch a paginated list of tournaments.
 */
declare function getTournaments(baseUrl: string, params?: TournamentListParams, ctx?: ApiContext$3): Promise<PaginatedResult<Tournament>>;
/**
 * Fetch a single tournament by ID.
 */
declare function getTournament(baseUrl: string, tournamentId: string, ctx?: ApiContext$3): Promise<Tournament>;
/**
 * Fetch the leaderboard for a tournament.
 */
declare function getTournamentLeaderboard(baseUrl: string, tournamentId: string, ctx?: ApiContext$3): Promise<LeaderboardEntry[]>;
/**
 * Fetch registrations for a tournament.
 */
declare function getTournamentRegistrations(baseUrl: string, tournamentId: string, params?: {
    limit?: number;
    offset?: number;
}, ctx?: ApiContext$3): Promise<PaginatedResult<Registration>>;
/**
 * Fetch prizes for a tournament.
 */
declare function getTournamentPrizes(baseUrl: string, tournamentId: string, ctx?: ApiContext$3): Promise<Prize[]>;

interface ApiContext$2 {
    retryAttempts?: number;
    retryDelay?: number;
    timeout?: number;
}
/**
 * Fetch tournaments for a player.
 */
declare function getPlayerTournaments(baseUrl: string, address: string, params?: {
    limit?: number;
    offset?: number;
}, ctx?: ApiContext$2): Promise<PaginatedResult<PlayerTournament>>;
/**
 * Fetch stats for a player.
 */
declare function getPlayerStats(baseUrl: string, address: string, ctx?: ApiContext$2): Promise<PlayerStats>;

interface ApiContext$1 {
    retryAttempts?: number;
    retryDelay?: number;
    timeout?: number;
}
/**
 * Fetch tournaments for a specific game.
 */
declare function getGameTournaments(baseUrl: string, gameAddress: string, params?: Omit<TournamentListParams, "gameAddress">, ctx?: ApiContext$1): Promise<PaginatedResult<Tournament>>;
/**
 * Fetch tournament stats for a specific game.
 */
declare function getGameStats(baseUrl: string, gameAddress: string, ctx?: ApiContext$1): Promise<PlatformStats>;

interface ApiContext {
    retryAttempts?: number;
    retryDelay?: number;
    timeout?: number;
}
/**
 * Fetch activity events with optional filtering.
 */
declare function getActivity(baseUrl: string, params?: ActivityParams, ctx?: ApiContext): Promise<PaginatedResult<ActivityEvent>>;
/**
 * Fetch platform-wide activity stats.
 */
declare function getActivityStats(baseUrl: string, ctx?: ApiContext): Promise<PlatformStats>;

interface WSManagerConfig {
    maxReconnectAttempts: number;
    reconnectBaseDelay: number;
}
/**
 * WebSocket manager with auto-reconnect and subscription management.
 */
declare class WSManager {
    private ws;
    private readonly wsUrl;
    private readonly config;
    private reconnectAttempts;
    private reconnectTimeout;
    private subscriptions;
    private nextSubId;
    private connected;
    private connectionListeners;
    constructor(wsUrl: string, config?: Partial<WSManagerConfig>);
    /**
     * Open a WebSocket connection. No-op if already connected.
     */
    connect(): void;
    /**
     * Close the WebSocket connection and stop reconnecting.
     */
    disconnect(): void;
    /**
     * Subscribe to channels with an optional tournament filter.
     * Returns an unsubscribe function.
     */
    subscribe(options: WSSubscribeOptions, handler: WSEventHandler): () => void;
    /**
     * Register a callback for a single message. Convenience wrapper around subscribe.
     * Returns an unsubscribe function.
     */
    onMessage(callback: WSEventHandler): () => void;
    /**
     * Whether the WebSocket is currently connected.
     */
    get isConnected(): boolean;
    /**
     * Register a listener for connection state changes.
     * Returns an unsubscribe function.
     */
    onConnectionChange(listener: (connected: boolean) => void): () => void;
    private notifyConnectionChange;
    private sendSubscribe;
    private attemptReconnect;
}

/**
 * Normalize a Starknet address to a 0x-prefixed, 66-character lowercase hex string.
 */
declare function normalizeAddress(address: string): string;

/**
 * Deeply convert all keys in an object from snake_case to camelCase.
 */
declare function snakeToCamel<T>(obj: unknown): T;
/**
 * Deeply convert all keys in an object from camelCase to snake_case.
 */
declare function camelToSnake<T>(obj: unknown): T;

declare function withRetry<T>(fn: () => Promise<T>, attempts?: number, delay?: number): Promise<T>;

interface ChainConfig {
    rpcUrl: string;
    apiBaseUrl: string;
    wsUrl: string;
}
declare const CHAINS: Record<string, ChainConfig>;
declare function getChainConfig(chain: string): ChainConfig | undefined;

export { ActivityEvent, ActivityParams, BudokanApiError, BudokanConnectionError, BudokanError, BudokanTimeoutError, CHAINS, type ChainConfig, LeaderboardEntry, PaginatedResult, PlatformStats, PlayerStats, PlayerTournament, Prize, Registration, Tournament, TournamentListParams, TournamentNotFoundError, WSEventHandler, WSManager, WSSubscribeOptions, camelToSnake, getActivity, getActivityStats, getChainConfig, getGameStats, getGameTournaments, getPlayerStats, getPlayerTournaments, getTournament, getTournamentLeaderboard, getTournamentPrizes, getTournamentRegistrations, getTournaments, normalizeAddress, snakeToCamel, withRetry };
