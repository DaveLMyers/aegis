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
      ctx({ writtenFiles: [{ path: '/project/src/target-project/db.ts', content: 'export const x = 1;' }] }),
    );
    expect(result.decision).toBe('allow');
  });

  it('blocks a write outside the allowed directories (change-control)', () => {
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({ writtenFiles: [{ path: '/etc/passwd', content: 'root:x:0:0' }] }),
    );
    expect(result.decision).toBe('block');
    expect(result.violations[0].message).toContain('change-control');
  });

  it('blocks a write outside allowed directories even when the agent omits it from filesChanged (regression: change-control must check what was actually written, not the agent\'s self-report)', () => {
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({
        // The agent's own report claims a clean, in-bounds write...
        result: { outputs: {}, rationale: 'test', filesChanged: ['src/target-project/db.ts'] },
        // ...but ChangeTracker shows it actually also wrote outside the sandbox.
        writtenFiles: [{ path: '/etc/passwd', content: 'root:x:0:0' }],
      }),
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
        result: { outputs: { generated: 'const key = "AKIAABCDEFGHIJKLMNOP";' }, rationale: 'test' },
        writtenFiles: [{ path: '/outside.ts', content: 'export const x = 1;' }],
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

  it('allows a design proposing only approved technologies', () => {
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({ stageId: 'design', result: { outputs: { technologies: ['typescript', 'express'] }, rationale: 'test' } }),
    );
    expect(result.decision).toBe('allow');
  });

  it('escalates an off-standard technology proposal to "ask", surfacing the design rationale', () => {
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({
        stageId: 'design',
        result: {
          outputs: { technologies: ['python', 'fastapi'] },
          rationale: 'requirement needs native ML libraries approved stack cannot provide; chose Python/FastAPI over Node because of that',
        },
      }),
    );
    expect(result.decision).toBe('ask');
    expect(result.violations[0].message).toContain('python');
    expect(result.violations[0].message).toContain('native ML libraries');
  });

  it('allows an off-standard technology once explicitly human-approved', () => {
    const engine = new PolicyEngine();
    const result = engine.check(
      ctx({
        stageId: 'design',
        result: { outputs: { technologies: ['python'], technologyApproved: true }, rationale: 'test' },
      }),
    );
    expect(result.decision).toBe('allow');
  });
});
