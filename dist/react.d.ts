import * as react_jsx_runtime from 'react/jsx-runtime';
import { ReactNode } from 'react';
import { h as BudokanClientConfig, B as BudokanClient, T as Tournament, a as PaginatedResult, b as TournamentListParams, L as LeaderboardEntry, d as PlayerTournament, c as PlayerStats, m as WSEventMessage, l as WSChannel } from './client-Bl4fuXK0.js';

interface BudokanProviderProps {
    children: ReactNode;
    config?: BudokanClientConfig;
    client?: BudokanClient;
}
/**
 * Provides a BudokanClient instance to all child components via React context.
 * Supply either a `config` prop to auto-create a client, or an existing `client` instance.
 */
declare function BudokanProvider({ children, config, client: existingClient }: BudokanProviderProps): react_jsx_runtime.JSX.Element;
/**
 * Access the BudokanClient instance from context.
 * Must be used within a BudokanProvider.
 */
declare function useBudokanClient(): BudokanClient;

interface UseTournamentsResult {
    tournaments: PaginatedResult<Tournament> | null;
    loading: boolean;
    error: Error | null;
    refetch: () => void;
}
/**
 * Hook to fetch a paginated list of tournaments.
 */
declare function useTournaments(params?: TournamentListParams): UseTournamentsResult;
interface UseTournamentResult {
    tournament: Tournament | null;
    loading: boolean;
    error: Error | null;
    refetch: () => void;
}
/**
 * Hook to fetch a single tournament by ID.
 */
declare function useTournament(tournamentId: string | undefined): UseTournamentResult;

interface UseLeaderboardResult {
    leaderboard: LeaderboardEntry[] | null;
    loading: boolean;
    error: Error | null;
    refetch: () => void;
}
/**
 * Hook to fetch the leaderboard for a tournament.
 */
declare function useLeaderboard(tournamentId: string | undefined): UseLeaderboardResult;

interface UsePlayerResult {
    tournaments: PaginatedResult<PlayerTournament> | null;
    stats: PlayerStats | null;
    loading: boolean;
    error: Error | null;
}
/**
 * Hook to fetch a player's tournament history and stats.
 */
declare function usePlayer(address: string | undefined): UsePlayerResult;
interface UsePlayerStatsResult {
    stats: PlayerStats | null;
    loading: boolean;
    error: Error | null;
    refetch: () => void;
}
/**
 * Hook to fetch stats for a player.
 */
declare function usePlayerStats(address: string | undefined): UsePlayerStatsResult;
interface UsePlayerTournamentsResult {
    tournaments: PaginatedResult<PlayerTournament> | null;
    loading: boolean;
    error: Error | null;
    refetch: () => void;
}
/**
 * Hook to fetch tournaments a player has registered for.
 */
declare function usePlayerTournaments(address: string | undefined): UsePlayerTournamentsResult;

interface UseSubscriptionResult {
    lastMessage: WSEventMessage | null;
    isConnected: boolean;
}
/**
 * Hook to subscribe to WebSocket channels for real-time updates.
 * Automatically connects and subscribes on mount, and cleans up on unmount.
 */
declare function useSubscription(channels: WSChannel[], tournamentIds?: string[]): UseSubscriptionResult;

/**
 * Simple hook returning the current WebSocket connection status.
 */
declare function useConnectionStatus(): {
    isConnected: boolean;
};

export { BudokanProvider, type BudokanProviderProps, type UseLeaderboardResult, type UsePlayerResult, type UsePlayerStatsResult, type UsePlayerTournamentsResult, type UseSubscriptionResult, type UseTournamentResult, type UseTournamentsResult, useBudokanClient, useConnectionStatus, useLeaderboard, usePlayer, usePlayerStats, usePlayerTournaments, useSubscription, useTournament, useTournaments };
