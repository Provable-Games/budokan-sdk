import { isNonRetryableError, BudokanTimeoutError } from "../errors/index.js";

export function calculateBackoff(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
): number {
  let delay = baseDelay * Math.pow(2, attempt);
  if (delay > maxDelay) delay = maxDelay;
  const minDelay = delay / 2;
  const jitter = Math.random() * (delay - minDelay);
  return minDelay + jitter;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number = 3,
  delay: number = 1000,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

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
