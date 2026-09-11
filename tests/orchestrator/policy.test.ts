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

  it('scans actual written file content for secrets, not just scalar outputs', () => {
    // Regression case: outputs.filesChanged is a list of paths, never file
    // content -- a secret sitting only in a written file's content, with
    // clean scalar outputs, must still be caught.
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({
        result: { outputs: { filesChanged: ['src/target-project/config.ts'] }, rationale: 'test' },
        writtenFiles: [{ path: '/project/src/target-project/config.ts', content: 'const key = "AKIAABCDEFGHIJKLMNOP";' }],
      }),
    );
    expect(result.decision).toBe('ask');
  });

  it('does not flag clean written file content', () => {
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({
        result: { outputs: { filesChanged: ['src/target-project/routes.ts'] }, rationale: 'test' },
        writtenFiles: [{ path: '/project/src/target-project/routes.ts', content: 'export const x = 1;' }],
      }),
    );
    expect(result.decision).toBe('allow');
  });
});
