export interface Registration {
  tournamentId: string;
  gameTokenId: string;
  gameAddress: string;
  playerAddress: string;
  entryNumber: number;
  hasSubmitted: boolean;
  isBanned: boolean;
}
