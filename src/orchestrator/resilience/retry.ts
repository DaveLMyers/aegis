export interface RetryOptions {
  maxAttempts: number;
  backoffMs: number;
  onAttempt?: (attempt: number, error: unknown) => void;
}

export type RetryOutcome<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: unknown; attempts: number };

export async function withRetry<T>(fn: () => Promise<T> | T, opts: RetryOptions): Promise<RetryOutcome<T>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const value = await fn();
      return { ok: true, value, attempts: attempt };
    } catch (error) {
      lastError = error;
      opts.onAttempt?.(attempt, error);
      if (attempt < opts.maxAttempts) {
        await sleep(opts.backoffMs * attempt);
      }
    }
  }
  return { ok: false, error: lastError, attempts: opts.maxAttempts };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
