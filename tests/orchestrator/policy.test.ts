import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../../src/orchestrator/policy/policyEngine.js';

const projectRoot = '/project';
const allowedWriteDirs = ['src/target-project'];

function ctx(overrides: Partial<Parameters<PolicyEngine['check']>[0]> = {}) {
  return {
    stageId: 'implementation' as const,
    result: { outputs: {}, rationale: 'test' },
    testingStageStatus: 'unknown' as const,
    projectRoot,
    allowedWriteDirs,
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  it('allows a clean stage result', () => {
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({ result: { outputs: {}, rationale: 'test', filesChanged: ['src/target-project/db.ts'] } }),
    );
    expect(result.decision).toBe('allow');
  });

  it('blocks a write outside the allowed directories (change-control)', () => {
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({ result: { outputs: {}, rationale: 'test', filesChanged: ['../../etc/passwd'] } }),
    );
    expect(result.decision).toBe('block');
    expect(result.violations[0].message).toContain('change-control');
  });

  it('blocks release-readiness without a passed testing stage (release-control)', () => {
    const engine = new PolicyEngine();
    const result = engine.check(ctx({ stageId: 'release-readiness', testingStageStatus: 'failed' }));
    expect(result.decision).toBe('block');
    expect(result.violations[0].message).toContain('release-control');
  });

  it('escalates a likely-secret match to "ask" rather than hard-blocking', () => {
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({ result: { outputs: { generated: 'const key = "AKIAABCDEFGHIJKLMNOP";' }, rationale: 'test' } }),
    );
    expect(result.decision).toBe('ask');
    expect(result.violations[0].severity).toBe('ask');
  });

  it('block takes precedence over ask when both are present', () => {
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({
        result: {
          outputs: { generated: 'const key = "AKIAABCDEFGHIJKLMNOP";' },
          rationale: 'test',
          filesChanged: ['../outside.ts'],
        },
      }),
    );
    expect(result.decision).toBe('block');
  });
});
