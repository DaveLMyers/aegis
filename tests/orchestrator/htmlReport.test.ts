import { describe, expect, it } from 'vitest';
import { renderReportHtml } from '../../src/orchestrator/observability/htmlReport.js';
import { ProjectContext } from '../../src/orchestrator/state/projectContext.js';
import type { RunMetrics } from '../../src/orchestrator/observability/metrics.js';
import type { AuditEvent, ScenarioDefinition, StageRecord } from '../../src/orchestrator/types.js';

const scenario: ScenarioDefinition = { name: 'html-test', type: 'greenfield', requirementText: 'Build a thing.' };

function stageRecord(overrides: Partial<StageRecord>): StageRecord {
  return {
    stageId: 'requirements',
    attempt: 1,
    startedAt: new Date().toISOString(),
    status: 'passed',
    inputs: {},
    outputs: {},
    rationale: 'test rationale',
    assumptions: [],
    filesChanged: [],
    ...overrides,
  };
}

function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runId: 'run-1',
    totalStagesAttempted: 9,
    stagesPassed: 9,
    successRate: 1,
    retryCount: 0,
    rollbackCount: 0,
    replanCount: 0,
    mttrMs: null,
    totalLatencyMs: 1234,
    ...overrides,
  };
}

describe('renderReportHtml', () => {
  it('renders a self-contained HTML document with the scenario, status, and metrics', () => {
    const ctx = new ProjectContext(scenario, 'run-1');
    ctx.append(stageRecord({ rationale: 'the requirement was normalized' }));

    const html = renderReportHtml(scenario, { status: 'completed' }, ctx, metrics(), []);

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('html-test');
    expect(html).toContain('the requirement was normalized');
    expect(html).toContain('completed');
    expect(html).toContain('100%');
  });

  it('renders the task graph as a table for the decomposition stage', () => {
    const ctx = new ProjectContext(scenario, 'run-2');
    ctx.append(
      stageRecord({
        stageId: 'decomposition',
        outputs: { tasks: [{ id: 'schema', description: 'design the schema', dependsOn: [], acceptanceCriteria: 'tables exist' }] },
      }),
    );

    const html = renderReportHtml(scenario, { status: 'completed' }, ctx, metrics(), []);

    expect(html).toContain('design the schema');
    expect(html).toContain('tables exist');
  });

  it('renders review findings and a halted status distinctly', () => {
    const ctx = new ProjectContext(scenario, 'run-3');
    ctx.append(stageRecord({ stageId: 'review', outputs: { reviewFindings: ['found a TODO'], reviewPassed: false } }));

    const html = renderReportHtml(scenario, { status: 'halted', haltedStage: 'review' }, ctx, metrics({ successRate: 0.5 }), []);

    expect(html).toContain('found a TODO');
    expect(html).toContain('halted');
  });

  it('escapes HTML in requirement text and rationale rather than injecting it raw', () => {
    const dangerous: ScenarioDefinition = { name: 'x', type: 'greenfield', requirementText: '<script>alert(1)</script>' };
    const ctx = new ProjectContext(dangerous, 'run-4');
    ctx.append(stageRecord({ rationale: '<img src=x onerror=alert(2)>' }));

    const html = renderReportHtml(dangerous, { status: 'completed' }, ctx, metrics(), []);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders re-planning events when present', () => {
    const ctx = new ProjectContext(scenario, 'run-5');
    ctx.append(stageRecord({}));
    const events: AuditEvent[] = [
      { ts: new Date().toISOString(), runId: 'run-5', type: 'replan', details: { fromStage: 'testing', targetStage: 'design', reason: 'bad assumption' } },
    ];

    const html = renderReportHtml(scenario, { status: 'completed' }, ctx, metrics({ replanCount: 1 }), events);

    expect(html).toContain('Re-planning events');
    expect(html).toContain('bad assumption');
  });
});
