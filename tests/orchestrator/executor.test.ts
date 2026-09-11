import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeGraph } from '../../src/orchestrator/graph/executor.js';
import { ProjectContext } from '../../src/orchestrator/state/projectContext.js';
import { AuditLog } from '../../src/orchestrator/observability/auditLog.js';
import { PolicyEngine } from '../../src/orchestrator/policy/policyEngine.js';
import type { Agent, StageExecutionOptions } from '../../src/orchestrator/agents/agent.js';
import type { RunOptions, ScenarioDefinition, StageExecutionResult, StageId } from '../../src/orchestrator/types.js';

/** Generic stage outputs that satisfy every real exit gate, for isolating executor/gate/resilience behavior from the URL-shortener playbooks. */
function defaultOutputsFor(stageId: StageId, io: StageExecutionOptions): StageExecutionResult {
  switch (stageId) {
    case 'requirements':
      return { outputs: { normalizedRequirement: 'x', assumptions: [] }, rationale: 'ok' };
    case 'design':
      return { outputs: { designDoc: 'x', impactedModules: [], technologies: ['typescript'] }, rationale: 'ok' };
    case 'implementation':
      return { outputs: { filesChanged: [] }, rationale: 'ok', filesChanged: [] };
    case 'test-authoring':
      return { outputs: { testFilesChanged: [] }, rationale: 'ok', filesChanged: [] };
    case 'testing':
      return { outputs: { testsPassed: true, testSummary: 'ok' }, rationale: 'ok' };
    case 'documentation':
      return { outputs: { docsChanged: [] }, rationale: 'ok', filesChanged: [] };
    case 'release-readiness':
      return { outputs: { approved: io.autoApprove }, rationale: 'ok' };
  }
}

class FakeAgent implements Agent {
  readonly mode = 'deterministic' as const;
  constructor(private readonly overrides: Partial<Record<StageId, (io: StageExecutionOptions) => StageExecutionResult>> = {}) {}

  async execute(stageId: StageId, _ctx: ProjectContext, io: StageExecutionOptions): Promise<StageExecutionResult> {
    if (io.simulateFailure) throw new Error(`simulated failure at ${stageId}`);
    return this.overrides[stageId]?.(io) ?? defaultOutputsFor(stageId, io);
  }
}

const scenario: ScenarioDefinition = { name: 'unit-test', type: 'greenfield', requirementText: 'n/a' };

function baseOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return { autoApprove: true, agentMode: 'deterministic', maxRetries: 2, maxReplans: 2, ...overrides };
}

describe('executeGraph', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'aegis-executor-test-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('completes all seven stages when everything succeeds', async () => {
    const ctx = new ProjectContext(scenario, 'run-1');
    const audit = new AuditLog(join(projectRoot, 'audit.log.jsonl'), 'run-1');
    const result = await executeGraph(ctx, new FakeAgent(), baseOptions(), audit, new PolicyEngine(), projectRoot, []);

    expect(result.status).toBe('completed');
    expect(ctx.records.filter((r) => r.status === 'passed')).toHaveLength(7);
    expect(ctx.hasPassed('release-readiness')).toBe(true);
  });

  it('runs implementation and test-authoring as a synchronized parallel pair', async () => {
    const order: string[] = [];
    const ctx = new ProjectContext(scenario, 'run-2');
    const audit = new AuditLog(join(projectRoot, 'audit.log.jsonl'), 'run-2');
    const agent = new FakeAgent({
      implementation: (io) => {
        order.push('implementation');
        return defaultOutputsFor('implementation', io);
      },
      'test-authoring': (io) => {
        order.push('test-authoring');
        return defaultOutputsFor('test-authoring', io);
      },
      testing: (io) => {
        order.push('testing');
        return defaultOutputsFor('testing', io);
      },
    });
    await executeGraph(ctx, agent, baseOptions(), audit, new PolicyEngine(), projectRoot, []);

    expect(order.indexOf('testing')).toBeGreaterThan(order.indexOf('implementation'));
    expect(order.indexOf('testing')).toBeGreaterThan(order.indexOf('test-authoring'));
  });

  it('recovers a transient failure via retry', async () => {
    const ctx = new ProjectContext(scenario, 'run-3');
    const audit = new AuditLog(join(projectRoot, 'audit.log.jsonl'), 'run-3');
    const options = baseOptions({ injectFailureAt: 'design', injectFailureSeverity: 'transient' });
    const result = await executeGraph(ctx, new FakeAgent(), options, audit, new PolicyEngine(), projectRoot, []);

    expect(result.status).toBe('completed');
    expect(ctx.latest('design')?.attempt).toBe(2);
    expect(audit.all().filter((e) => e.type === 'retry')).toHaveLength(1);
  });

  it('exhausts retry and fallback on a hard failure, then rolls back and safe-stops', async () => {
    const ctx = new ProjectContext(scenario, 'run-4');
    const audit = new AuditLog(join(projectRoot, 'audit.log.jsonl'), 'run-4');
    const options = baseOptions({ injectFailureAt: 'implementation', injectFailureSeverity: 'hard', maxRetries: 1 });
    const result = await executeGraph(ctx, new FakeAgent(), options, audit, new PolicyEngine(), projectRoot, []);

    expect(result.status).toBe('halted');
    expect(result.haltedStage).toBe('implementation');
    expect(audit.all().map((e) => e.type)).toEqual(
      expect.arrayContaining(['fallback', 'stage-fail', 'rollback', 'safe-stop']),
    );
    expect(ctx.hasPassed('testing')).toBe(false);
  });

  it('re-enters an upstream stage when a downstream stage signals invalidation, then completes', async () => {
    let testingCalls = 0;
    const ctx = new ProjectContext(scenario, 'run-5');
    const audit = new AuditLog(join(projectRoot, 'audit.log.jsonl'), 'run-5');
    const agent = new FakeAgent({
      testing: (io) => {
        testingCalls++;
        const base = defaultOutputsFor('testing', io);
        if (testingCalls === 1) {
          return { ...base, upstreamInvalidated: { stageId: 'design', reason: 'discovered a bad assumption' } };
        }
        return base;
      },
    });
    const result = await executeGraph(ctx, agent, baseOptions(), audit, new PolicyEngine(), projectRoot, []);

    expect(result.status).toBe('completed');
    expect(testingCalls).toBe(2);
    expect(audit.all().filter((e) => e.type === 'replan')).toHaveLength(1);
    expect(ctx.records.filter((r) => r.stageId === 'design')).toHaveLength(1);
  });

  it('records rationale and assumptions for audit-grade decision lineage', async () => {
    const ctx = new ProjectContext(scenario, 'run-6');
    const audit = new AuditLog(join(projectRoot, 'audit.log.jsonl'), 'run-6');
    const agent = new FakeAgent({
      requirements: () => ({
        outputs: { normalizedRequirement: 'x', assumptions: ['assumed A', 'assumed B'] },
        rationale: 'explained why',
        assumptions: ['assumed A', 'assumed B'],
      }),
    });
    await executeGraph(ctx, agent, baseOptions(), audit, new PolicyEngine(), projectRoot, []);

    const requirementsRecord = ctx.latest('requirements');
    expect(requirementsRecord?.rationale).toBe('explained why');
    expect(requirementsRecord?.assumptions).toEqual(['assumed A', 'assumed B']);
  });
});
