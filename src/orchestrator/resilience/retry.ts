export interface RetryOptions {
  maxAttempts: number;
  backoffMs: number;
  onAttempt?: (attempt: number, error: unknown) => void;
  /** When an error matches this, stop retrying immediately instead of spending the remaining attempts -- for errors that reflect a decision (e.g. a human explicitly rejecting something) rather than a transient failure retrying might recover from. */
  isTerminal?: (error: unknown) => boolean;
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
      if (opts.isTerminal?.(error)) {
        return { ok: false, error, attempts: attempt };
      }
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
