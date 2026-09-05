import type { BackoffOptions } from "./types.js";

export const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  type: "exponential",
  initialMs: 1000,
  maxMs: 30000,
  jitter: true,
};

export function calculateBackoffDelay(
  attemptNumber: number,
  options?: BackoffOptions
): number {
  const initialMs = options?.initialMs ?? DEFAULT_BACKOFF.initialMs;
  const maxMs = options?.maxMs ?? DEFAULT_BACKOFF.maxMs;
  const useJitter = options?.jitter ?? DEFAULT_BACKOFF.jitter;

  const baseDelay = Math.min(initialMs * Math.pow(2, Math.max(0, attemptNumber - 1)), maxMs);

  if (!useJitter) {
    return Math.round(baseDelay);
  }

  const jitterFactor = 0.8 + Math.random() * 0.4;
  return Math.min(Math.round(baseDelay * jitterFactor), maxMs);
}
