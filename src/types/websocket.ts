/**
 * Server-side broadcast channels a client may subscribe to. Each maps to a
 * stream the Budokan API emits; subscribing to a channel the server doesn't
 * emit yields no events.
 *
 * - `tournaments`   — tournament create / phase / metadata changes
 * - `registrations` — new entries (game tokens) joining a tournament
 * - `submissions`   — score submissions to a tournament leaderboard
 *                     (see {@link WSSubmissionData})
 * - `prizes`        — prize pools added / funded
 * - `rewards`       — rewards claimed / distributed
 * - `metrics`       — aggregate counters
 */
export type WSChannel =
  | "tournaments"
  | "registrations"
  | "submissions"
  | "prizes"
  | "rewards"
  | "metrics";

/**
 * Shape of a `submissions`-channel event's `data`. Emitted when a registration's
 * `has_submitted` flips true (a score submission). Fields arrive snake_cased
 * from the API. The registrations table has no score column (scores live
 * on-chain), so the event identifies the entry — read the leaderboard for the
 * value.
 */
export interface WSSubmissionData {
  tournament_id: string | number;
  /** The entry (game token) whose score was submitted. */
  game_token_id: string;
  entry_number: number | null;
  has_submitted: boolean;
}

export interface WSSubscribeMessage {
  type: "subscribe";
  channels: WSChannel[];
  tournamentIds?: string[];
}

export interface WSUnsubscribeMessage {
  type: "unsubscribe";
  channels: WSChannel[];
}

export interface WSEventMessage {
  type: "event";
  channel: WSChannel;
  data: Record<string, unknown>;
  timestamp: string;
}

export type WSMessage = WSSubscribeMessage | WSUnsubscribeMessage | WSEventMessage;

export interface WSSubscribeOptions {
  channels: WSChannel[];
  tournamentIds?: string[];
}

export type WSEventHandler = (message: WSEventMessage) => void;
