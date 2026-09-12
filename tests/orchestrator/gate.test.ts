import { describe, expect, it } from 'vitest';
import { allOf, requireOutputKeys, requireOutputTrue, requireStagesPassed, requireValidTaskGraph } from '../../src/orchestrator/gates/gate.js';
import type { StageExecutionResult, StageRecord, Task } from '../../src/orchestrator/types.js';

function task(overrides: Partial<Task> = {}): Task {
  return { id: 't', description: 'x', dependsOn: [], acceptanceCriteria: 'x', ...overrides };
}

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

describe('requireValidTaskGraph', () => {
  const gate = requireValidTaskGraph();

  it('fails when tasks is missing or empty', () => {
    expect(gate({} as any, fakeResult({})).ok).toBe(false);
    expect(gate({} as any, fakeResult({ tasks: [] })).ok).toBe(false);
  });

  it('fails on a duplicate task id', () => {
    const result = gate({} as any, fakeResult({ tasks: [task({ id: 'a' }), task({ id: 'a' })] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('duplicate');
  });

  it('fails when a task depends on an id that does not exist', () => {
    const result = gate({} as any, fakeResult({ tasks: [task({ id: 'a', dependsOn: ['ghost'] })] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ghost');
  });

  it('fails on a dependency cycle', () => {
    const result = gate({} as any, fakeResult({
      tasks: [task({ id: 'a', dependsOn: ['b'] }), task({ id: 'b', dependsOn: ['a'] })],
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('cycle');
  });

  it('passes a real, valid dependency graph', () => {
    const result = gate({} as any, fakeResult({
      tasks: [
        task({ id: 'schema', dependsOn: [] }),
        task({ id: 'create', dependsOn: ['schema'] }),
        task({ id: 'tests', dependsOn: ['schema', 'create'] }),
      ],
    }));
    expect(result.ok).toBe(true);
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
