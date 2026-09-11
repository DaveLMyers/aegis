import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicReviewPlaybook, readChangedFiles } from '../../src/orchestrator/agents/playbooks/review.js';
import { ProjectContext } from '../../src/orchestrator/state/projectContext.js';
import type { ScenarioDefinition, StageExecutionOptions, StageRecord } from '../../src/orchestrator/types.js';
import { ChangeTracker } from '../../src/orchestrator/resilience/rollback.js';

const scenario: ScenarioDefinition = { name: 'review-test', type: 'adhoc', requirementText: 'test' };

function record(overrides: Partial<StageRecord>): StageRecord {
  return {
    stageId: 'implementation',
    attempt: 1,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: 'passed',
    inputs: {},
    outputs: {},
    rationale: 'test',
    assumptions: [],
    filesChanged: [],
    ...overrides,
  };
}

function io(overrides: Partial<StageExecutionOptions> = {}): StageExecutionOptions {
  return { tracker: new ChangeTracker('/unused'), simulateFailure: false, fallback: false, autoApprove: true, ...overrides };
}

describe('deterministicReviewPlaybook', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'aegis-review-test-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('passes with no findings when changed files are clean', () => {
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src', 'a.ts'), 'export const x = 1;');
    const ctx = new ProjectContext(scenario, 'run-1');
    ctx.append(record({ filesChanged: ['src/a.ts'] }));

    const result = deterministicReviewPlaybook(ctx, io(), projectRoot);

    expect(result.outputs.reviewPassed).toBe(true);
    expect(result.outputs.reviewFindings).toEqual([]);
  });

  it('flags a TODO marker left in changed code', () => {
    writeFileSync(join(projectRoot, 'a.ts'), '// TODO: finish this\nexport const x = 1;');
    const ctx = new ProjectContext(scenario, 'run-2');
    ctx.append(record({ filesChanged: ['a.ts'] }));

    const result = deterministicReviewPlaybook(ctx, io(), projectRoot);

    expect(result.outputs.reviewPassed).toBe(false);
    expect((result.outputs.reviewFindings as string[])[0]).toContain('TODO');
  });

  it('flags an empty changed file', () => {
    writeFileSync(join(projectRoot, 'empty.ts'), '   ');
    const ctx = new ProjectContext(scenario, 'run-3');
    ctx.append(record({ filesChanged: ['empty.ts'] }));

    const result = deterministicReviewPlaybook(ctx, io(), projectRoot);

    expect(result.outputs.reviewPassed).toBe(false);
    expect((result.outputs.reviewFindings as string[])[0]).toContain('empty');
  });

  it('throws on simulateFailure, same as every other playbook', () => {
    const ctx = new ProjectContext(scenario, 'run-4');
    expect(() => deterministicReviewPlaybook(ctx, io({ simulateFailure: true }), projectRoot)).toThrow();
  });
});

describe('readChangedFiles', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'aegis-review-readfiles-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reads content only for files that actually exist on disk', () => {
    writeFileSync(join(projectRoot, 'exists.ts'), 'content');
    const ctx = new ProjectContext(scenario, 'run-5');
    ctx.append(record({ filesChanged: ['exists.ts', 'missing.ts'] }));

    const files = readChangedFiles(ctx, projectRoot);

    expect(files).toEqual([{ path: 'exists.ts', content: 'content' }]);
  });
});
