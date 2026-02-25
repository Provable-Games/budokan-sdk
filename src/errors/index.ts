export class BudokanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudokanError";
  }
}

export class BudokanApiError extends BudokanError {
  readonly status: number;
  readonly statusText: string;

  constructor(message: string, status: number, statusText: string = "") {
    super(message);
    this.name = "BudokanApiError";
    this.status = status;
    this.statusText = statusText;
  }
}

export class BudokanTimeoutError extends BudokanError {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "BudokanTimeoutError";
  }
}

export class BudokanConnectionError extends BudokanError {
  constructor(message = "Connection failed") {
    super(message);
    this.name = "BudokanConnectionError";
  }
}

export class TournamentNotFoundError extends BudokanError {
  readonly tournamentId: string;

  constructor(tournamentId: string) {
    super(`Tournament not found: ${tournamentId}`);
    this.name = "TournamentNotFoundError";
    this.tournamentId = tournamentId;
  }
}

export function isNonRetryableError(error: unknown): boolean {
  if (error instanceof TournamentNotFoundError) return true;
  if (error instanceof BudokanApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
    return true;
  }
  return false;
}
