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
