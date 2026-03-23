import type { Tournament, Phase } from "./tournament.js";
import type { Registration } from "./registration.js";

export interface PlayerStats {
  totalTournaments: number;
  totalSubmissions: number;
}

export interface PlayerTournament extends Tournament {
  registration: Registration;
}

export interface PlayerTournamentParams {
  phase?: Phase;
  gameTokenIds?: string[];
  limit?: number;
  offset?: number;
}
