import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeGraph } from '../../src/orchestrator/graph/executor.js';
import { ProjectContext } from '../../src/orchestrator/state/projectContext.js';
import { AuditLog } from '../../src/orchestrator/observability/auditLog.js';
import { PolicyEngine } from '../../src/orchestrator/policy/policyEngine.js';
import { computeMetrics } from '../../src/orchestrator/observability/metrics.js';
import type { Agent, StageExecutionOptions } from '../../src/orchestrator/agents/agent.js';
import type { RunOptions, ScenarioDefinition, StageExecutionResult, StageId } from '../../src/orchestrator/types.js';

/** Generic stage outputs that satisfy every real exit gate, for isolating executor/gate/resilience behavior from the URL-shortener playbooks. */
function defaultOutputsFor(stageId: StageId, io: StageExecutionOptions): StageExecutionResult {
  switch (stageId) {
    case 'requirements':
      return { outputs: { normalizedRequirement: 'x', assumptions: [] }, rationale: 'ok' };
    case 'decomposition':
      return { outputs: { tasks: [{ id: 't1', description: 'x', dependsOn: [], acceptanceCriteria: 'x' }] }, rationale: 'ok' };
    case 'design':
      return { outputs: { designDoc: 'x', impactedModules: [], technologies: ['typescript'] }, rationale: 'ok' };
    case 'implementation':
      return { outputs: { filesChanged: [] }, rationale: 'ok', filesChanged: [] };
    case 'test-authoring':
      return { outputs: { testFilesChanged: [] }, rationale: 'ok', filesChanged: [] };
    case 'testing':
      return { outputs: { testsPassed: true, testSummary: 'ok' }, rationale: 'ok' };
    case 'review':
      return { outputs: { reviewFindings: [], reviewPassed: true }, rationale: 'ok' };
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

  it('completes all nine stages when everything succeeds', async () => {
    const ctx = new ProjectContext(scenario, 'run-1');
    const audit = new AuditLog(join(projectRoot, 'audit.log.jsonl'), 'run-1');
    const result = await executeGraph(ctx, new FakeAgent(), baseOptions(), audit, new PolicyEngine(), projectRoot, []);

    expect(result.status).toBe('completed');
    expect(ctx.records.filter((r) => r.status === 'passed')).toHaveLength(9);
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
    expect(ctx.records.filter((r) => r.stageId === 'design')).toHaveLength(2);
  });

  it('--trigger-replan forces a re-plan even when the agent itself never flags one', async () => {
    // Unlike the test above, this FakeAgent never sets upstreamInvalidated --
    // RunOptions.triggerReplan is what injects it, at the executor level,
    // proving the demonstration flag actually drives the real mechanism.
    const ctx = new ProjectContext(scenario, 'run-7');
    const audit = new AuditLog(join(projectRoot, 'audit.log.jsonl'), 'run-7');
    let testingCalls = 0;
    const agent = new FakeAgent({
      testing: (io) => {
        testingCalls++;
        return defaultOutputsFor('testing', io);
      },
    });
    const options = baseOptions({ triggerReplan: { atStage: 'testing', targetStage: 'design' } });
    const result = await executeGraph(ctx, agent, options, audit, new PolicyEngine(), projectRoot, []);

    expect(result.status).toBe('completed');
    expect(testingCalls).toBe(2);
    expect(audit.all().filter((e) => e.type === 'replan')).toHaveLength(1);
    expect(ctx.records.filter((r) => r.stageId === 'design')).toHaveLength(2);
  });

  it('halts immediately on an explicit release-readiness rejection, without retrying or falling back', async () => {
    const ctx = new ProjectContext(scenario, 'run-8');
    const audit = new AuditLog(join(projectRoot, 'audit.log.jsonl'), 'run-8');
    let releaseReadinessCalls = 0;
    const agent = new FakeAgent({
      'release-readiness': () => {
        releaseReadinessCalls++;
        return { outputs: { approved: false, releaseSummary: 'rejected by test' }, rationale: 'human said no' };
      },
    });
    const options = baseOptions({ autoApprove: false });
    const result = await executeGraph(ctx, agent, options, audit, new PolicyEngine(), projectRoot, []);

    expect(result.status).toBe('halted');
    expect(result.haltedStage).toBe('release-readiness');
    // A rejection is a decision, not a failure to retry -- exactly one call,
    // no re-prompting, no fallback attempt.
    expect(releaseReadinessCalls).toBe(1);
    expect(ctx.latest('release-readiness')?.status).toBe('halted');
    expect(ctx.latest('release-readiness')?.attempt).toBe(1);
    const eventTypes = audit.all().map((e) => e.type);
    expect(eventTypes).toContain('approval-rejected');
    expect(eventTypes).not.toContain('retry');
    expect(eventTypes).not.toContain('fallback');
    expect(eventTypes).not.toContain('stage-fail');
  });

  it('recovers via fallback and produces a real, non-null MTTR (regression: stage-fail must fire on primary exhaustion, not only on total failure)', async () => {
    const ctx = new ProjectContext(scenario, 'run-9');
    const audit = new AuditLog(join(projectRoot, 'audit.log.jsonl'), 'run-9');
    const agent = new FakeAgent({
      design: (io) => {
        if (!io.fallback) throw new Error('primary attempt fails, fallback recovers');
        return defaultOutputsFor('design', io);
      },
    });
    const options = baseOptions({ maxRetries: 1 });
    const result = await executeGraph(ctx, agent, options, audit, new PolicyEngine(), projectRoot, []);

    expect(result.status).toBe('completed');
    expect(ctx.latest('design')?.status).toBe('passed');
    const eventTypes = audit.all().map((e) => e.type);
    expect(eventTypes).toContain('stage-fail');
    expect(eventTypes).toContain('fallback');

    const metrics = computeMetrics('run-9', audit.all());
    expect(metrics.mttrMs).not.toBeNull();
    expect(metrics.mttrMs).toBeGreaterThanOrEqual(0);
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
