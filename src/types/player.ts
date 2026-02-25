import type { Tournament } from "./tournament.js";
import type { Registration } from "./registration.js";

export interface PlayerStats {
  totalTournaments: number;
  totalSubmissions: number;
}

export interface PlayerTournament extends Tournament {
  registration: Registration;
}
