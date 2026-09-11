import { describe, expect, it } from 'vitest';
import { withRetry } from '../../src/orchestrator/resilience/retry.js';

describe('withRetry', () => {
  it('returns immediately on first success', async () => {
    const outcome = await withRetry(() => 'ok', { maxAttempts: 3, backoffMs: 0 });
    expect(outcome).toEqual({ ok: true, value: 'ok', attempts: 1 });
  });

  it('recovers on a later attempt', async () => {
    let calls = 0;
    const outcome = await withRetry(
      () => {
        calls++;
        if (calls < 2) throw new Error('transient');
        return 'recovered';
      },
      { maxAttempts: 3, backoffMs: 0 },
    );
    expect(outcome).toEqual({ ok: true, value: 'recovered', attempts: 2 });
  });

  it('exhausts attempts and reports failure', async () => {
    const outcome = await withRetry(
      () => {
        throw new Error('always fails');
      },
      { maxAttempts: 2, backoffMs: 0 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.attempts).toBe(2);
      expect(String(outcome.error)).toContain('always fails');
    }
  });

  it('calls onAttempt for every failed attempt', async () => {
    const seen: number[] = [];
    await withRetry(
      () => {
        throw new Error('nope');
      },
      { maxAttempts: 3, backoffMs: 0, onAttempt: (attempt) => seen.push(attempt) },
    );
    expect(seen).toEqual([1, 2, 3]);
  });
});
