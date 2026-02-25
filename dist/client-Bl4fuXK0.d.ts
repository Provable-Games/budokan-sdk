interface BudokanClientConfig {
    apiBaseUrl: string;
    wsUrl?: string;
    rpcUrl?: string;
    contractAddress?: string;
    retryAttempts?: number;
    retryDelay?: number;
    timeout?: number;
}

interface Tournament {
    tournamentId: string;
    gameAddress: string;
    createdAt: string;
    createdBy: string;
    creatorTokenId: string | null;
    name: string;
    description: string;
    registrationStartDelay: number | null;
    registrationEndDelay: number | null;
    gameStartDelay: number | null;
    gameEndDelay: number | null;
    submissionDuration: number | null;
    createdAtOnchain: string | null;
    registrationStartTime: string | null;
    registrationEndTime: string | null;
    gameStartTime: string | null;
    gameEndTime: string | null;
    submissionEndTime: string | null;
    settingsId: number | null;
    soulbound: boolean | null;
    paymaster: boolean | null;
    clientUrl: string | null;
    renderer: string | null;
    leaderboardAscending: boolean | null;
    leaderboardGameMustBeOver: boolean | null;
    entryFeeToken: string | null;
    entryFeeAmount: string | null;
    hasEntryRequirement: boolean | null;
    schedule: Schedule | null;
    gameConfig: GameConfig | null;
    entryFee: EntryFee | null;
    entryRequirement: unknown | null;
    leaderboardConfig: LeaderboardConfig | null;
    entryCount: number;
    prizeCount: number;
    submissionCount: number;
    metadata: unknown | null;
}
interface Schedule {
    registrationStartDelay: number;
    registrationEndDelay: number;
    gameStartDelay: number;
    gameEndDelay: number;
    submissionDuration: number;
}
interface GameConfig {
    gameAddress: string;
    settingsId: number;
    soulbound: boolean;
    paymaster: boolean;
    clientUrl: string | null;
    renderer: string | null;
}
interface EntryFee {
    tokenAddress: string;
    amount: string;
    tournamentCreatorShare: number;
    gameCreatorShare: number;
    refundShare: number;
    distribution: unknown;
    distributionCount: number;
}
interface LeaderboardConfig {
    ascending: boolean;
    gameMustBeOver: boolean;
}
type Phase = "scheduled" | "registration" | "staging" | "live" | "submission" | "finalized";
interface TournamentListParams {
    gameAddress?: string;
    creator?: string;
    phase?: Phase;
    limit?: number;
    offset?: number;
}

interface LeaderboardEntry {
    position: number;
    tokenId: string;
}

interface Registration {
    tournamentId: string;
    gameTokenId: string;
    gameAddress: string;
    playerAddress: string;
    entryNumber: number;
    hasSubmitted: boolean;
    isBanned: boolean;
}

interface Prize {
    prizeId: string;
    tournamentId: string;
    payoutPosition: number;
    tokenAddress: string;
    tokenType: unknown;
    sponsorAddress: string;
}
interface RewardClaim {
    tournamentId: string;
    rewardType: unknown;
    claimed: boolean;
}

interface PlayerStats {
    totalTournaments: number;
    totalSubmissions: number;
}
interface PlayerTournament extends Tournament {
    registration: Registration;
}

interface ActivityEvent {
    id: string;
    eventType: string;
    tournamentId: string | null;
    playerAddress: string | null;
    data: unknown;
    blockNumber: string;
    txHash: string;
    eventIndex: number;
}
interface ActivityParams {
    eventType?: string;
    tournamentId?: string;
    playerAddress?: string;
    limit?: number;
    offset?: number;
}
interface PlatformStats {
    totalTournaments: number;
    totalPrizes: number;
    totalRegistrations: number;
    totalSubmissions: number;
}

interface PaginatedResult<T> {
    data: T[];
    total?: number;
    limit: number;
    offset: number;
}

type WSChannel = "tournaments" | "registrations" | "leaderboards" | "prizes" | "rewards";
interface WSSubscribeMessage {
    type: "subscribe";
    channels: WSChannel[];
    tournamentIds?: string[];
}
interface WSUnsubscribeMessage {
    type: "unsubscribe";
    channels: WSChannel[];
}
interface WSEventMessage {
    type: "event";
    channel: WSChannel;
    data: unknown;
    timestamp: string;
}
type WSMessage = WSSubscribeMessage | WSUnsubscribeMessage | WSEventMessage;
interface WSSubscribeOptions {
    channels: WSChannel[];
    tournamentIds?: string[];
}
type WSEventHandler = (message: WSEventMessage) => void;

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
declare class BudokanClient {
    private readonly config;
    private readonly wsManager;
    constructor(config: BudokanClientConfig);
    /** Returns the resolved configuration. */
    get clientConfig(): BudokanClientConfig;
    /** Whether the WebSocket is currently connected. */
    get wsConnected(): boolean;
    private get apiCtx();
    /**
     * Fetch a paginated list of tournaments with optional filtering.
     */
    getTournaments(params?: TournamentListParams): Promise<PaginatedResult<Tournament>>;
    /**
     * Fetch a single tournament by its ID.
     */
    getTournament(tournamentId: string): Promise<Tournament>;
    /**
     * Fetch the leaderboard for a tournament.
     */
    getTournamentLeaderboard(tournamentId: string): Promise<LeaderboardEntry[]>;
    /**
     * Fetch registrations for a tournament.
     */
    getTournamentRegistrations(tournamentId: string, params?: {
        limit?: number;
        offset?: number;
    }): Promise<PaginatedResult<Registration>>;
    /**
     * Fetch prizes for a tournament.
     */
    getTournamentPrizes(tournamentId: string): Promise<Prize[]>;
    /**
     * Fetch tournaments that a player has registered for.
     */
    getPlayerTournaments(address: string, params?: {
        limit?: number;
        offset?: number;
    }): Promise<PaginatedResult<PlayerTournament>>;
    /**
     * Fetch stats for a player.
     */
    getPlayerStats(address: string): Promise<PlayerStats>;
    /**
     * Fetch tournaments for a specific game.
     */
    getGameTournaments(gameAddress: string, params?: Omit<TournamentListParams, "gameAddress">): Promise<PaginatedResult<Tournament>>;
    /**
     * Fetch tournament stats for a specific game.
     */
    getGameStats(gameAddress: string): Promise<PlatformStats>;
    /**
     * Fetch activity events with optional filtering.
     */
    getActivity(params?: ActivityParams): Promise<PaginatedResult<ActivityEvent>>;
    /**
     * Fetch platform-wide activity stats.
     */
    getActivityStats(): Promise<PlatformStats>;
    /**
     * Open a WebSocket connection for real-time updates.
     */
    connect(): void;
    /**
     * Close the WebSocket connection.
     */
    disconnect(): void;
    /**
     * Subscribe to WebSocket channels with optional tournament filtering.
     * Returns an unsubscribe function.
     */
    subscribe(channels: WSChannel[], handler: WSEventHandler, tournamentIds?: string[]): () => void;
    /**
     * Register a listener for WebSocket connection state changes.
     * Returns an unsubscribe function.
     */
    onWsConnectionChange(listener: (connected: boolean) => void): () => void;
}
/**
 * Factory function for creating a BudokanClient instance.
 */
declare function createBudokanClient(config: BudokanClientConfig): BudokanClient;

export { type ActivityParams as A, BudokanClient as B, type EntryFee as E, type GameConfig as G, type LeaderboardEntry as L, type Prize as P, type Registration as R, type Schedule as S, type Tournament as T, type WSSubscribeOptions as W, type PaginatedResult as a, type TournamentListParams as b, type PlayerStats as c, type PlayerTournament as d, type PlatformStats as e, type ActivityEvent as f, type WSEventHandler as g, type BudokanClientConfig as h, type LeaderboardConfig as i, type Phase as j, type RewardClaim as k, type WSChannel as l, type WSEventMessage as m, type WSMessage as n, type WSSubscribeMessage as o, type WSUnsubscribeMessage as p, createBudokanClient as q };
