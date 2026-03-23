export interface ActivityEvent {
  id: string;
  eventType: string;
  tournamentId: string | null;
  playerAddress: string | null;
  data: unknown;
  blockNumber: string;
  txHash: string;
  eventIndex: number;
}

export interface ActivityParams {
  eventType?: string;
  tournamentId?: string;
  playerAddress?: string;
  limit?: number;
  offset?: number;
}

export interface PlatformStats {
  totalTournaments: number;
  totalPrizes: number;
  totalRegistrations: number;
  totalSubmissions: number;
}

export interface PrizeStats {
  tokenTotals: Array<{
    tokenAddress: string;
    totalPrizes: number;
    totalAmount: string;
  }>;
  totalNftPrizes: number;
}
