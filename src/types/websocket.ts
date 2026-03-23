export type WSChannel = "tournaments" | "registrations" | "leaderboards" | "prizes" | "rewards" | "metrics";

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
  data: unknown;
  timestamp: string;
}

export type WSMessage = WSSubscribeMessage | WSUnsubscribeMessage | WSEventMessage;

export interface WSSubscribeOptions {
  channels: WSChannel[];
  tournamentIds?: string[];
}

export type WSEventHandler = (message: WSEventMessage) => void;
