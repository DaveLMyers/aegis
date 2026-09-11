import { describe, expect, it } from 'vitest';
import { allOf, requireOutputKeys, requireOutputTrue, requireStagesPassed } from '../../src/orchestrator/gates/gate.js';
import type { StageExecutionResult, StageRecord } from '../../src/orchestrator/types.js';

function fakeResult(outputs: Record<string, unknown>): StageExecutionResult {
  return { outputs, rationale: 'test' };
}

describe('requireOutputKeys', () => {
  it('passes when all keys are present', () => {
    const gate = requireOutputKeys(['a', 'b']);
    expect(gate({} as any, fakeResult({ a: 1, b: 2 })).ok).toBe(true);
  });

  it('fails and names the missing keys', () => {
    const gate = requireOutputKeys(['a', 'b']);
    const result = gate({} as any, fakeResult({ a: 1 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('b');
  });
});

describe('requireOutputTrue', () => {
  it('fails when the flag is not exactly true', () => {
    expect(requireOutputTrue('approved')({} as any, fakeResult({ approved: false })).ok).toBe(false);
    expect(requireOutputTrue('approved')({} as any, fakeResult({})).ok).toBe(false);
  });

  it('passes when the flag is true', () => {
    expect(requireOutputTrue('approved')({} as any, fakeResult({ approved: true })).ok).toBe(true);
  });
});

describe('requireStagesPassed', () => {
  const makeCtx = (passed: Set<string>) => ({
    hasPassed: (id: string) => passed.has(id),
    latest: () => undefined as StageRecord | undefined,
  });

  it('fails when an upstream stage has not passed', () => {
    const gate = requireStagesPassed(['requirements', 'design'] as any);
    const result = gate(makeCtx(new Set(['requirements'])) as any);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('design');
  });

  it('passes once every upstream stage has passed', () => {
    const gate = requireStagesPassed(['requirements', 'design'] as any);
    expect(gate(makeCtx(new Set(['requirements', 'design'])) as any).ok).toBe(true);
  });
});

describe('allOf', () => {
  it('short-circuits on the first failing gate', () => {
    const alwaysFail = () => ({ ok: false, reason: 'first' });
    const neverCalled = () => ({ ok: false, reason: 'second' });
    const result = allOf(alwaysFail, neverCalled)({} as any, fakeResult({}));
    expect(result.reason).toBe('first');
  });

  it('passes only when every gate passes', () => {
    const ok = () => ({ ok: true, reason: 'fine' });
    expect(allOf(ok, ok)({} as any, fakeResult({})).ok).toBe(true);
  });
});
