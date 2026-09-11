import { describe, expect, it } from 'vitest';
import { buildPrBody, collectChangedFiles } from '../../src/orchestrator/agents/playbooks/githubApproval.js';
import { ProjectContext } from '../../src/orchestrator/state/projectContext.js';
import type { ScenarioDefinition, StageRecord } from '../../src/orchestrator/types.js';

const scenario: ScenarioDefinition = { name: 'demo', type: 'adhoc', requirementText: 'Build a thing' };

function record(overrides: Partial<StageRecord>): StageRecord {
  return {
    stageId: 'implementation',
    attempt: 1,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: 'passed',
    inputs: {},
    outputs: {},
    rationale: 'did the thing',
    assumptions: [],
    filesChanged: [],
    ...overrides,
  };
}

describe('collectChangedFiles', () => {
  it('deduplicates files across stages', () => {
    const ctx = new ProjectContext(scenario, 'run-1');
    ctx.append(record({ stageId: 'implementation', filesChanged: ['a.ts', 'b.ts'] }));
    ctx.append(record({ stageId: 'test-authoring', filesChanged: ['a.test.ts'] }));
    ctx.append(record({ stageId: 'documentation', filesChanged: ['a.ts'] })); // duplicate

    expect(collectChangedFiles(ctx)).toEqual(['a.ts', 'b.ts', 'a.test.ts']);
  });

  it('returns an empty list when nothing wrote files', () => {
    const ctx = new ProjectContext(scenario, 'run-2');
    ctx.append(record({ filesChanged: [] }));
    expect(collectChangedFiles(ctx)).toEqual([]);
  });
});

describe('buildPrBody', () => {
  it('includes the requirement, every stage rationale, and the merge-is-approval note', () => {
    const ctx = new ProjectContext(scenario, 'run-3');
    ctx.append(record({ stageId: 'requirements', rationale: 'interpreted the ask' }));
    ctx.append(record({ stageId: 'design', rationale: 'chose an approach', assumptions: ['assumed X'] }));

    const body = buildPrBody(ctx);

    expect(body).toContain('Build a thing');
    expect(body).toContain('interpreted the ask');
    expect(body).toContain('chose an approach');
    expect(body).toContain('assumed X');
    expect(body).toContain('Merging this PR');
    expect(body).toContain('release-readiness');
  });
});
