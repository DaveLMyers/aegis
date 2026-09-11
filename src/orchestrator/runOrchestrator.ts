import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectContext } from './state/projectContext.js';
import { AuditLog } from './observability/auditLog.js';
import { PolicyEngine } from './policy/policyEngine.js';
import { computeMetrics, type RunMetrics } from './observability/metrics.js';
import { executeGraph, type RunResult } from './graph/executor.js';
import { DeterministicAgent } from './agents/deterministicAgent.js';
import type { Agent } from './agents/agent.js';
import type { RunOptions, ScenarioDefinition } from './types.js';

export interface RunSummary {
  runId: string;
  status: 'completed' | 'halted';
  haltedStage?: string;
  outputDir: string;
}

const ALLOWED_WRITE_DIRS = ['src/target-project', 'tests/target-project', 'docs/generated'];

export async function runScenario(
  scenario: ScenarioDefinition,
  options: RunOptions,
  projectRoot: string,
): Promise<RunSummary> {
  const runId = `${scenario.name}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outputDir = join(projectRoot, 'scenarios', 'runs', scenario.name, runId);
  mkdirSync(outputDir, { recursive: true });

  const ctx = new ProjectContext(scenario, runId);
  const audit = new AuditLog(join(outputDir, 'audit.log.jsonl'), runId);
  const policy = new PolicyEngine();

  let agent: Agent;
  if (options.agentMode === 'llm') {
    const { ClaudeAgent } = await import('./agents/claudeAgent.js');
    agent = new ClaudeAgent();
  } else {
    agent = new DeterministicAgent(projectRoot);
  }

  audit.record('run-start', {
    scenario: scenario.name,
    type: scenario.type,
    agentMode: options.agentMode,
    autoApprove: options.autoApprove,
    injectFailureAt: options.injectFailureAt ?? null,
    injectFailureSeverity: options.injectFailureSeverity ?? null,
  });

  const result = await executeGraph(ctx, agent, options, audit, policy, projectRoot, ALLOWED_WRITE_DIRS);

  audit.record('run-end', { status: result.status, haltedStage: result.haltedStage ?? null });

  const metrics = computeMetrics(runId, audit.all());

  writeFileSync(join(outputDir, 'context.json'), JSON.stringify(ctx.toJSON(), null, 2), 'utf-8');
  writeFileSync(join(outputDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf-8');
  writeFileSync(join(outputDir, 'report.md'), renderReport(scenario, result, ctx, metrics), 'utf-8');

  return { runId, status: result.status, haltedStage: result.haltedStage, outputDir };
}

function renderReport(scenario: ScenarioDefinition, result: RunResult, ctx: ProjectContext, metrics: RunMetrics): string {
  const lines: string[] = [];
  lines.push(`# AEGIS run report -- ${scenario.name}`);
  lines.push('');
  lines.push(`**Type:** ${scenario.type}`);
  lines.push(`**Requirement:** ${scenario.requirementText}`);
  lines.push(`**Status:** ${result.status}${result.haltedStage ? ` (halted at \`${result.haltedStage}\`)` : ''}`);
  lines.push('');
  lines.push('## Stage-by-stage decision lineage');
  for (const record of ctx.records) {
    lines.push(`### \`${record.stageId}\` (attempt ${record.attempt}, ${record.status})`);
    lines.push(`- Rationale: ${record.rationale}`);
    if (record.assumptions.length > 0) lines.push(`- Assumptions: ${record.assumptions.join('; ')}`);
    if (record.filesChanged.length > 0) lines.push(`- Files changed: ${record.filesChanged.join(', ')}`);
    lines.push('');
  }
  lines.push('## Reliability metrics');
  lines.push(`- Success rate: ${(metrics.successRate * 100).toFixed(0)}%`);
  lines.push(`- Stages attempted: ${metrics.totalStagesAttempted}, passed: ${metrics.stagesPassed}`);
  lines.push(`- Retries: ${metrics.retryCount}`);
  lines.push(`- Rollbacks: ${metrics.rollbackCount}`);
  lines.push(`- Replans: ${metrics.replanCount}`);
  lines.push(`- MTTR: ${metrics.mttrMs === null ? 'n/a (no failures recovered in this run)' : `${metrics.mttrMs.toFixed(0)}ms`}`);
  lines.push(`- Total latency: ${metrics.totalLatencyMs}ms`);
  return lines.join('\n');
}
