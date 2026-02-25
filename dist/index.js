// src/errors/index.ts
var BudokanError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BudokanError";
  }
};
var BudokanApiError = class extends BudokanError {
  status;
  statusText;
  constructor(message, status, statusText = "") {
    super(message);
    this.name = "BudokanApiError";
    this.status = status;
    this.statusText = statusText;
  }
};
var BudokanTimeoutError = class extends BudokanError {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "BudokanTimeoutError";
  }
};
var BudokanConnectionError = class extends BudokanError {
  constructor(message = "Connection failed") {
    super(message);
    this.name = "BudokanConnectionError";
  }
};
var TournamentNotFoundError = class extends BudokanError {
  tournamentId;
  constructor(tournamentId) {
    super(`Tournament not found: ${tournamentId}`);
    this.name = "TournamentNotFoundError";
    this.tournamentId = tournamentId;
  }
};
function isNonRetryableError(error) {
  if (error instanceof TournamentNotFoundError) return true;
  if (error instanceof BudokanApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
    return true;
  }
  return false;
}

// src/utils/retry.ts
function calculateBackoff(attempt, baseDelay, maxDelay) {
  let delay = baseDelay * Math.pow(2, attempt);
  if (delay > maxDelay) delay = maxDelay;
  const minDelay = delay / 2;
  const jitter = Math.random() * (delay - minDelay);
  return minDelay + jitter;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function withRetry(fn, attempts = 3, delay = 1e3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isNonRetryableError(error)) {
        throw error;
      }
      if (attempt === attempts - 1) break;
      const backoff = calculateBackoff(attempt, delay, delay * 8);
      await sleep(backoff);
    }
  }
  throw lastError ?? new BudokanTimeoutError("Unknown error after retries");
}

// src/api/base.ts
var DEFAULT_TIMEOUT = 1e4;
var DEFAULT_RETRY_ATTEMPTS = 3;
var DEFAULT_RETRY_DELAY = 1e3;
async function apiFetch(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    signal,
    timeout = DEFAULT_TIMEOUT,
    retryAttempts = DEFAULT_RETRY_ATTEMPTS,
    retryDelay = DEFAULT_RETRY_DELAY
  } = options;
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeoutId);
          throw new BudokanTimeoutError("Request was aborted");
        }
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      try {
        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers
          },
          body: body ? JSON.stringify(body) : void 0,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          throw new BudokanApiError(
            errorBody.error ?? `API error: ${response.status}`,
            response.status,
            response.statusText
          );
        }
        return await response.json();
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof BudokanApiError) {
          throw error;
        }
        if (error instanceof Error && error.name === "AbortError") {
          if (signal?.aborted) throw new BudokanTimeoutError("Request was aborted");
          throw new BudokanTimeoutError();
        }
        throw new BudokanConnectionError(
          error instanceof Error ? error.message : "Connection failed"
        );
      }
    },
    retryAttempts,
    retryDelay
  );
}
function buildQueryString(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0 && value !== null) {
      qs.set(key, String(value));
    }
  }
  const str = qs.toString();
  return str ? `?${str}` : "";
}

// src/utils/mappers.ts
function toCamelCase(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}
function toSnakeCase(str) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function snakeToCamel(obj) {
  if (Array.isArray(obj)) {
    return obj.map((item) => snakeToCamel(item));
  }
  if (obj !== null && typeof obj === "object" && !(obj instanceof Date)) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[toCamelCase(key)] = snakeToCamel(value);
    }
    return result;
  }
  return obj;
}
function camelToSnake(obj) {
  if (Array.isArray(obj)) {
    return obj.map((item) => camelToSnake(item));
  }
  if (obj !== null && typeof obj === "object" && !(obj instanceof Date)) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[toSnakeCase(key)] = camelToSnake(value);
    }
    return result;
  }
  return obj;
}

// src/api/tournaments.ts
function fetchOpts(ctx) {
  return {
    retryAttempts: ctx?.retryAttempts,
    retryDelay: ctx?.retryDelay,
    timeout: ctx?.timeout
  };
}
async function getTournaments(baseUrl, params, ctx) {
  const qs = buildQueryString({
    game_address: params?.gameAddress,
    creator: params?.creator,
    phase: params?.phase,
    limit: params?.limit,
    offset: params?.offset
  });
  const result = await apiFetch(`${baseUrl}/tournaments${qs}`, fetchOpts(ctx));
  return {
    data: result.data.map((item) => snakeToCamel(item)),
    total: result.total,
    limit: result.limit,
    offset: result.offset
  };
}
async function getTournament(baseUrl, tournamentId, ctx) {
  const result = await apiFetch(
    `${baseUrl}/tournaments/${tournamentId}`,
    fetchOpts(ctx)
  );
  return snakeToCamel(result.data);
}
async function getTournamentLeaderboard(baseUrl, tournamentId, ctx) {
  const result = await apiFetch(
    `${baseUrl}/tournaments/${tournamentId}/leaderboard`,
    fetchOpts(ctx)
  );
  return result.data.map((item) => snakeToCamel(item));
}
async function getTournamentRegistrations(baseUrl, tournamentId, params, ctx) {
  const qs = buildQueryString({
    limit: params?.limit,
    offset: params?.offset
  });
  const result = await apiFetch(`${baseUrl}/tournaments/${tournamentId}/registrations${qs}`, fetchOpts(ctx));
  return {
    data: result.data.map((item) => snakeToCamel(item)),
    total: result.total,
    limit: result.limit,
    offset: result.offset
  };
}
async function getTournamentPrizes(baseUrl, tournamentId, ctx) {
  const result = await apiFetch(
    `${baseUrl}/tournaments/${tournamentId}/prizes`,
    fetchOpts(ctx)
  );
  return result.data.map((item) => snakeToCamel(item));
}

// src/utils/address.ts
function normalizeAddress(address) {
  const stripped = address.replace(/^0x0*/i, "");
  return ("0x" + stripped.padStart(64, "0")).toLowerCase();
}

// src/api/players.ts
function fetchOpts2(ctx) {
  return {
    retryAttempts: ctx?.retryAttempts,
    retryDelay: ctx?.retryDelay,
    timeout: ctx?.timeout
  };
}
async function getPlayerTournaments(baseUrl, address, params, ctx) {
  const normalized = normalizeAddress(address);
  const qs = buildQueryString({
    limit: params?.limit,
    offset: params?.offset
  });
  const result = await apiFetch(`${baseUrl}/players/${normalized}/tournaments${qs}`, fetchOpts2(ctx));
  return {
    data: result.data.map((item) => snakeToCamel(item)),
    total: result.total,
    limit: result.limit,
    offset: result.offset
  };
}
async function getPlayerStats(baseUrl, address, ctx) {
  const normalized = normalizeAddress(address);
  const result = await apiFetch(
    `${baseUrl}/players/${normalized}/stats`,
    fetchOpts2(ctx)
  );
  return snakeToCamel(result.data);
}

// src/api/games.ts
function fetchOpts3(ctx) {
  return {
    retryAttempts: ctx?.retryAttempts,
    retryDelay: ctx?.retryDelay,
    timeout: ctx?.timeout
  };
}
async function getGameTournaments(baseUrl, gameAddress, params, ctx) {
  const normalized = normalizeAddress(gameAddress);
  const qs = buildQueryString({
    creator: params?.creator,
    phase: params?.phase,
    limit: params?.limit,
    offset: params?.offset
  });
  const result = await apiFetch(`${baseUrl}/games/${normalized}/tournaments${qs}`, fetchOpts3(ctx));
  return {
    data: result.data.map((item) => snakeToCamel(item)),
    total: result.total,
    limit: result.limit,
    offset: result.offset
  };
}
async function getGameStats(baseUrl, gameAddress, ctx) {
  const normalized = normalizeAddress(gameAddress);
  const result = await apiFetch(
    `${baseUrl}/games/${normalized}/stats`,
    fetchOpts3(ctx)
  );
  return snakeToCamel(result.data);
}

// src/api/activity.ts
function fetchOpts4(ctx) {
  return {
    retryAttempts: ctx?.retryAttempts,
    retryDelay: ctx?.retryDelay,
    timeout: ctx?.timeout
  };
}
async function getActivity(baseUrl, params, ctx) {
  const qs = buildQueryString({
    event_type: params?.eventType,
    tournament_id: params?.tournamentId,
    player_address: params?.playerAddress,
    limit: params?.limit,
    offset: params?.offset
  });
  const result = await apiFetch(`${baseUrl}/activity${qs}`, fetchOpts4(ctx));
  return {
    data: result.data.map((item) => snakeToCamel(item)),
    total: result.total,
    limit: result.limit,
    offset: result.offset
  };
}
async function getActivityStats(baseUrl, ctx) {
  const result = await apiFetch(
    `${baseUrl}/activity/stats`,
    fetchOpts4(ctx)
  );
  return snakeToCamel(result.data);
}

// src/ws/manager.ts
var DEFAULT_WS_CONFIG = {
  maxReconnectAttempts: 10,
  reconnectBaseDelay: 1e3
};
var WSManager = class {
  ws = null;
  wsUrl;
  config;
  reconnectAttempts = 0;
  reconnectTimeout = null;
  subscriptions = /* @__PURE__ */ new Map();
  nextSubId = 1;
  connected = false;
  connectionListeners = /* @__PURE__ */ new Set();
  constructor(wsUrl, config) {
    this.wsUrl = wsUrl;
    this.config = { ...DEFAULT_WS_CONFIG, ...config };
  }
  /**
   * Open a WebSocket connection. No-op if already connected.
   */
  connect() {
    if (this.ws) return;
    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.notifyConnectionChange(true);
        for (const [, sub] of this.subscriptions) {
          this.sendSubscribe(sub.options);
        }
      };
      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "event") {
            for (const [, sub] of this.subscriptions) {
              sub.handler(message);
            }
          }
        } catch {
        }
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.notifyConnectionChange(false);
        this.ws = null;
        this.attemptReconnect();
      };
      this.ws.onerror = () => {
      };
    } catch {
      this.attemptReconnect();
    }
  }
  /**
   * Close the WebSocket connection and stop reconnecting.
   */
  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.notifyConnectionChange(false);
    this.reconnectAttempts = 0;
  }
  /**
   * Subscribe to channels with an optional tournament filter.
   * Returns an unsubscribe function.
   */
  subscribe(options, handler) {
    const id = String(this.nextSubId++);
    this.subscriptions.set(id, { options, handler });
    if (this.connected) {
      this.sendSubscribe(options);
    }
    return () => {
      this.subscriptions.delete(id);
      if (this.connected && this.ws) {
        this.ws.send(JSON.stringify({
          type: "unsubscribe",
          channels: options.channels
        }));
      }
    };
  }
  /**
   * Register a callback for a single message. Convenience wrapper around subscribe.
   * Returns an unsubscribe function.
   */
  onMessage(callback) {
    const id = String(this.nextSubId++);
    this.subscriptions.set(id, {
      options: { channels: [] },
      handler: callback
    });
    return () => {
      this.subscriptions.delete(id);
    };
  }
  /**
   * Whether the WebSocket is currently connected.
   */
  get isConnected() {
    return this.connected;
  }
  /**
   * Register a listener for connection state changes.
   * Returns an unsubscribe function.
   */
  onConnectionChange(listener) {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }
  notifyConnectionChange(isConnected) {
    for (const listener of this.connectionListeners) {
      try {
        listener(isConnected);
      } catch {
      }
    }
  }
  sendSubscribe(options) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (options.channels.length === 0) return;
    this.ws.send(JSON.stringify({
      type: "subscribe",
      channels: options.channels,
      tournamentIds: options.tournamentIds
    }));
  }
  attemptReconnect() {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) return;
    if (this.subscriptions.size === 0) return;
    const delay = this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, Math.min(delay, 3e4));
  }
};

// src/client.ts
var BudokanClient = class {
  config;
  wsManager;
  constructor(config) {
    this.config = config;
    const wsUrl = config.wsUrl ?? config.apiBaseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    this.wsManager = new WSManager(wsUrl);
  }
  // ---- Configuration ----
  /** Returns the resolved configuration. */
  get clientConfig() {
    return { ...this.config };
  }
  /** Whether the WebSocket is currently connected. */
  get wsConnected() {
    return this.wsManager.isConnected;
  }
  // ---- API context ----
  get apiCtx() {
    return {
      retryAttempts: this.config.retryAttempts,
      retryDelay: this.config.retryDelay,
      timeout: this.config.timeout
    };
  }
  // ---- Tournament Queries ----
  /**
   * Fetch a paginated list of tournaments with optional filtering.
   */
  async getTournaments(params) {
    return getTournaments(this.config.apiBaseUrl, params, this.apiCtx);
  }
  /**
   * Fetch a single tournament by its ID.
   */
  async getTournament(tournamentId) {
    return getTournament(this.config.apiBaseUrl, tournamentId, this.apiCtx);
  }
  /**
   * Fetch the leaderboard for a tournament.
   */
  async getTournamentLeaderboard(tournamentId) {
    return getTournamentLeaderboard(this.config.apiBaseUrl, tournamentId, this.apiCtx);
  }
  /**
   * Fetch registrations for a tournament.
   */
  async getTournamentRegistrations(tournamentId, params) {
    return getTournamentRegistrations(this.config.apiBaseUrl, tournamentId, params, this.apiCtx);
  }
  /**
   * Fetch prizes for a tournament.
   */
  async getTournamentPrizes(tournamentId) {
    return getTournamentPrizes(this.config.apiBaseUrl, tournamentId, this.apiCtx);
  }
  // ---- Player Queries ----
  /**
   * Fetch tournaments that a player has registered for.
   */
  async getPlayerTournaments(address, params) {
    return getPlayerTournaments(this.config.apiBaseUrl, address, params, this.apiCtx);
  }
  /**
   * Fetch stats for a player.
   */
  async getPlayerStats(address) {
    return getPlayerStats(this.config.apiBaseUrl, address, this.apiCtx);
  }
  // ---- Game Queries ----
  /**
   * Fetch tournaments for a specific game.
   */
  async getGameTournaments(gameAddress, params) {
    return getGameTournaments(this.config.apiBaseUrl, gameAddress, params, this.apiCtx);
  }
  /**
   * Fetch tournament stats for a specific game.
   */
  async getGameStats(gameAddress) {
    return getGameStats(this.config.apiBaseUrl, gameAddress, this.apiCtx);
  }
  // ---- Activity Queries ----
  /**
   * Fetch activity events with optional filtering.
   */
  async getActivity(params) {
    return getActivity(this.config.apiBaseUrl, params, this.apiCtx);
  }
  /**
   * Fetch platform-wide activity stats.
   */
  async getActivityStats() {
    return getActivityStats(this.config.apiBaseUrl, this.apiCtx);
  }
  // ---- WebSocket ----
  /**
   * Open a WebSocket connection for real-time updates.
   */
  connect() {
    this.wsManager.connect();
  }
  /**
   * Close the WebSocket connection.
   */
  disconnect() {
    this.wsManager.disconnect();
  }
  /**
   * Subscribe to WebSocket channels with optional tournament filtering.
   * Returns an unsubscribe function.
   */
  subscribe(channels, handler, tournamentIds) {
    return this.wsManager.subscribe({ channels, tournamentIds }, handler);
  }
  /**
   * Register a listener for WebSocket connection state changes.
   * Returns an unsubscribe function.
   */
  onWsConnectionChange(listener) {
    return this.wsManager.onConnectionChange(listener);
  }
};
function createBudokanClient(config) {
  return new BudokanClient(config);
}

// src/chains/constants.ts
var CHAINS = {
  mainnet: {
    rpcUrl: "https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_10",
    apiBaseUrl: "https://budokan-api.provable.games",
    wsUrl: "wss://budokan-api.provable.games/ws"
  },
  sepolia: {
    rpcUrl: "https://starknet-sepolia.public.blastapi.io",
    apiBaseUrl: "https://budokan-api-sepolia.provable.games",
    wsUrl: "wss://budokan-api-sepolia.provable.games/ws"
  }
};
function getChainConfig(chain) {
  return CHAINS[chain];
}

export { BudokanApiError, BudokanClient, BudokanConnectionError, BudokanError, BudokanTimeoutError, CHAINS, TournamentNotFoundError, WSManager, camelToSnake, createBudokanClient, getActivity, getActivityStats, getChainConfig, getGameStats, getGameTournaments, getPlayerStats, getPlayerTournaments, getTournament, getTournamentLeaderboard, getTournamentPrizes, getTournamentRegistrations, getTournaments, normalizeAddress, snakeToCamel, withRetry };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map