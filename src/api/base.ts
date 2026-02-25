import { BudokanApiError, BudokanTimeoutError, BudokanConnectionError } from "../errors/index.js";
import { withRetry } from "../utils/retry.js";

export interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY = 1000;

/**
 * Fetch JSON from an API endpoint with retry logic, timeout, and error handling.
 */
export async function apiFetch<T>(url: string, options: ApiFetchOptions = {}): Promise<T> {
  const {
    method = "GET",
    headers = {},
    body,
    signal,
    timeout = DEFAULT_TIMEOUT,
    retryAttempts = DEFAULT_RETRY_ATTEMPTS,
    retryDelay = DEFAULT_RETRY_DELAY,
  } = options;

  return withRetry(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // Link external signal
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
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorBody = await response.json().catch(() => ({}));
          throw new BudokanApiError(
            (errorBody as Record<string, string>).error ?? `API error: ${response.status}`,
            response.status,
            response.statusText,
          );
        }

        return (await response.json()) as T;
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
          error instanceof Error ? error.message : "Connection failed",
        );
      }
    },
    retryAttempts,
    retryDelay,
  );
}

/**
 * Build a query string from a record of key-value pairs.
 * Undefined and null values are omitted.
 */
export function buildQueryString(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      qs.set(key, String(value));
    }
  }
  const str = qs.toString();
  return str ? `?${str}` : "";
}
