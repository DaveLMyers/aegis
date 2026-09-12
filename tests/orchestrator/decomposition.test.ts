import { describe, expect, it } from 'vitest';
import { decompositionPlaybooks } from '../../src/orchestrator/agents/playbooks/decomposition.js';
import { requireValidTaskGraph } from '../../src/orchestrator/gates/gate.js';
import { ProjectContext } from '../../src/orchestrator/state/projectContext.js';
import type { ScenarioDefinition, StageExecutionResult, Task } from '../../src/orchestrator/types.js';
import type { StageExecutionOptions } from '../../src/orchestrator/agents/agent.js';

const io = { tracker: {} as any, simulateFailure: false, fallback: false, autoApprove: true } as StageExecutionOptions;

function ctxWithRequirements(type: ScenarioDefinition['type'], requirementsOutputs: Record<string, unknown>): ProjectContext {
  const scenario: ScenarioDefinition = { name: 'test', type, requirementText: 'n/a' };
  const ctx = new ProjectContext(scenario, 'run-1');
  ctx.append({
    stageId: 'requirements',
    attempt: 1,
    startedAt: new Date().toISOString(),
    status: 'passed',
    inputs: {},
    outputs: requirementsOutputs,
    rationale: 'test',
    assumptions: [],
    filesChanged: [],
  });
  return ctx;
}

/** Every scenario's decomposition output must satisfy the real structural gate, not just have the right shape. */
function assertValidTaskGraph(result: StageExecutionResult) {
  const gateResult = requireValidTaskGraph()({} as any, result);
  expect(gateResult.ok).toBe(true);
  const tasks = result.outputs.tasks as Task[];
  expect(tasks.length).toBeGreaterThan(0);
  return tasks;
}

describe('decompositionPlaybooks', () => {
  it('greenfield: derives tasks from requirements\' recorded scope', () => {
    const ctx = ctxWithRequirements('greenfield', { scope: ['POST /links', 'GET /:code', 'GET /:code/stats'] });
    const result = decompositionPlaybooks.greenfield(ctx, io);
    const tasks = assertValidTaskGraph(result);
    expect(tasks.some((t) => t.description.includes('POST /links'))).toBe(true);
  });

  it('brownfield: derives different tasks than greenfield for the same requirement scope shape', () => {
    const ctx = ctxWithRequirements('brownfield', { scope: ['client_tier on links', 'POST /links accepts clientTier', 'tiered limiter on GET /:code'] });
    const result = decompositionPlaybooks.brownfield(ctx, io);
    const tasks = assertValidTaskGraph(result);
    const greenfieldTasks = assertValidTaskGraph(
      decompositionPlaybooks.greenfield(ctxWithRequirements('greenfield', { scope: [] }), io),
    );
    const taskIds = tasks.map((t) => t.id);
    const greenfieldIds = greenfieldTasks.map((t) => t.id);
    expect(taskIds).not.toEqual(greenfieldIds);
    expect(tasks.some((t) => t.id === 'inspect')).toBe(true);
  });

  it('ambiguous: derives tasks from the chosen interpretation, not the raw ambiguous text', () => {
    const ctx = ctxWithRequirements('ambiguous', {
      normalizedRequirement: 'Richer analytics for premium clients: referrer breakdown.',
    });
    const result = decompositionPlaybooks.ambiguous(ctx, io);
    const tasks = assertValidTaskGraph(result);
    expect(tasks.some((t) => t.description.includes('referrer breakdown'))).toBe(true);
  });

  it('throws on injected failure, same as every other playbook', () => {
    const ctx = ctxWithRequirements('greenfield', { scope: [] });
    expect(() => decompositionPlaybooks.greenfield(ctx, { ...io, simulateFailure: true })).toThrow();
  });
});
