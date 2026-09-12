import { STAGE_GRAPH } from '../graph/stageGraph.js';
import type { RunResult } from '../graph/executor.js';
import type { ProjectContext } from '../state/projectContext.js';
import type { AuditEvent, ScenarioDefinition, StageRecord, Task } from '../types.js';
import type { RunMetrics } from './metrics.js';

/**
 * A single self-contained HTML file per run -- no build step, no server,
 * no external dependencies -- so opening a run's evidence is "double-click
 * report.html," not "open a markdown file in an editor." Renders the same
 * data as report.md (same source of truth: ctx, metrics, events), just as
 * a dashboard a human actually wants to look at.
 */

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusColor(status: string): string {
  if (status === 'passed' || status === 'completed') return '#1e7f4f';
  if (status === 'halted' || status === 'failed') return '#b3261e';
  return '#8a6d00';
}

function pill(text: string, color: string): string {
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${color}1a;color:${color};font-weight:600;font-size:0.8em;">${esc(text)}</span>`;
}

/** Green when healthy, amber when degraded, red when it's actually a problem -- not just three shades of the same "everything is fine" gray. */
function metricTone(value: number, kind: 'rate' | 'countBad' | 'countInfo'): string {
  if (kind === 'rate') return value >= 0.8 ? '#1e7f4f' : value >= 0.5 ? '#8a6d00' : '#b3261e';
  if (kind === 'countBad') return value === 0 ? '#1e7f4f' : value <= 2 ? '#8a6d00' : '#b3261e';
  return '#2e6da4';
}

function statCard(label: string, value: string, color: string, note?: string): string {
  return `<div style="background:#fff;border:1px solid #e2e5e9;border-left:4px solid ${color};border-radius:8px;padding:14px 16px;min-width:150px;">
    <div style="font-size:0.78em;color:#5a5a5a;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">${esc(label)}</div>
    <div style="font-size:1.6em;font-weight:700;color:${color};line-height:1.1;">${esc(value)}</div>
    ${note ? `<div style="font-size:0.78em;color:#8a8a8a;margin-top:3px;">${esc(note)}</div>` : ''}
  </div>`;
}

function renderTaskGraph(tasks: Task[]): string {
  if (tasks.length === 0) return '';
  const rows = tasks
    .map(
      (t) => `<tr>
        <td style="font-family:ui-monospace,Consolas,monospace;font-weight:600;">${esc(t.id)}</td>
        <td>${esc(t.description)}</td>
        <td style="font-family:ui-monospace,Consolas,monospace;color:#5a5a5a;">${t.dependsOn.length > 0 ? esc(t.dependsOn.join(', ')) : '(none)'}</td>
        <td style="color:#5a5a5a;">${esc(t.acceptanceCriteria)}</td>
      </tr>`,
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:0.9em;">
    <thead><tr style="text-align:left;border-bottom:2px solid #e2e5e9;">
      <th style="padding:6px 8px;">Task</th><th style="padding:6px 8px;">Description</th><th style="padding:6px 8px;">Depends on</th><th style="padding:6px 8px;">Done when</th>
    </tr></thead>
    <tbody>${rows.replace(/<td/g, '<td style="padding:6px 8px;border-bottom:1px solid #eee;"')}</tbody>
  </table>`;
}

function renderStageCard(record: StageRecord): string {
  const color = statusColor(record.status);
  let extra = '';

  if (record.stageId === 'decomposition') {
    const tasks = (record.outputs.tasks as Task[] | undefined) ?? [];
    extra = renderTaskGraph(tasks);
  }
  if (record.stageId === 'review') {
    const findings = (record.outputs.reviewFindings as string[] | undefined) ?? [];
    extra = `<div style="margin-top:6px;"><strong>Findings:</strong> ${
      findings.length === 0 ? '<span style="color:#1e7f4f;">none</span>' : esc(findings.join('; '))
    }</div>`;
  }
  if (record.stageId === 'release-readiness' && typeof record.outputs.releaseSummary === 'string') {
    extra = `<div style="margin-top:6px;background:#f4f7fa;border-radius:6px;padding:8px 10px;">${esc(record.outputs.releaseSummary)}</div>`;
  }

  return `<div style="background:#fff;border:1px solid #e2e5e9;border-radius:8px;padding:14px 16px;margin-bottom:10px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <span style="font-family:ui-monospace,Consolas,monospace;font-weight:700;font-size:1.05em;">${esc(record.stageId)}</span>
      ${pill(record.status, color)}
      <span style="color:#8a8a8a;font-size:0.85em;">attempt ${esc(record.attempt)}</span>
    </div>
    <div style="color:#333;">${esc(record.rationale)}</div>
    ${record.assumptions.length > 0 ? `<div style="margin-top:6px;color:#5a5a5a;font-size:0.9em;"><strong>Assumptions:</strong> ${esc(record.assumptions.join('; '))}</div>` : ''}
    ${record.filesChanged.length > 0 ? `<div style="margin-top:6px;color:#5a5a5a;font-size:0.9em;font-family:ui-monospace,Consolas,monospace;"><strong style="font-family:inherit;">Files:</strong> ${esc(record.filesChanged.join(', '))}</div>` : ''}
    ${extra}
  </div>`;
}

export function renderReportHtml(
  scenario: ScenarioDefinition,
  result: RunResult,
  ctx: ProjectContext,
  metrics: RunMetrics,
  events: AuditEvent[],
): string {
  const statusPillColor = result.status === 'completed' ? '#1e7f4f' : '#b3261e';
  const replanEvents = events.filter((e) => e.type === 'replan');

  const metricsGrid = [
    statCard('Success rate', `${(metrics.successRate * 100).toFixed(0)}%`, metricTone(metrics.successRate, 'rate'), `${metrics.stagesPassed} of ${STAGE_GRAPH.length} stages`),
    statCard('Stages attempted', String(metrics.totalStagesAttempted), '#2e6da4'),
    statCard('Retries', String(metrics.retryCount), metricTone(metrics.retryCount, 'countBad')),
    statCard('Rollbacks', String(metrics.rollbackCount), metricTone(metrics.rollbackCount, 'countBad')),
    statCard('Replans', String(metrics.replanCount), metricTone(metrics.replanCount, 'countInfo')),
    statCard('MTTR', metrics.mttrMs === null ? 'n/a' : `${metrics.mttrMs.toFixed(0)}ms`, metrics.mttrMs === null ? '#8a8a8a' : '#2e6da4', metrics.mttrMs === null ? 'no recovered failure this run' : undefined),
    statCard('Total latency', `${metrics.totalLatencyMs}ms`, '#2e6da4'),
  ].join('');

  const replanSection =
    replanEvents.length > 0
      ? `<h2 style="margin-top:28px;">Re-planning events</h2>
         <ul style="line-height:1.7;">${replanEvents
           .map((e) => `<li><code style="background:#f4f7fa;padding:1px 5px;border-radius:4px;">${esc(e.details.fromStage)}</code> flagged <code style="background:#f4f7fa;padding:1px 5px;border-radius:4px;">${esc(e.details.targetStage)}</code> as invalidated: ${esc(e.details.reason)}</li>`)
           .join('')}</ul>
         <p style="color:#8a8a8a;font-size:0.9em;">The stage-by-stage lineage below includes both the pre- and post-replan records for every affected stage, in order -- nothing is pruned.</p>`
      : '';

  const stageCards = ctx.records.map(renderStageCard).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AEGIS run report -- ${esc(scenario.name)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; background:#f4f6f8; color:#1a1a1a; margin:0; padding:32px; }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { margin: 0 0 4px 0; font-size: 1.5em; }
  h2 { font-size: 1.1em; border-bottom: 1px solid #e2e5e9; padding-bottom: 6px; }
  .meta { color:#5a5a5a; margin-bottom: 20px; }
  .grid { display:flex; flex-wrap:wrap; gap:12px; }
  code { font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body>
<div class="wrap">
  <h1>AEGIS run report</h1>
  <div class="meta">
    <div><strong>${esc(scenario.name)}</strong> &middot; type: <code>${esc(scenario.type)}</code> &middot; ${pill(result.status, statusPillColor)}${result.haltedStage ? ` at <code>${esc(result.haltedStage)}</code>` : ''}</div>
    <div style="margin-top:4px;">${esc(scenario.requirementText)}</div>
  </div>

  <h2>Reliability metrics</h2>
  <div class="grid">${metricsGrid}</div>

  ${replanSection}

  <h2 style="margin-top:28px;">Stage-by-stage decision lineage</h2>
  ${stageCards}

  <p style="color:#8a8a8a;font-size:0.8em;margin-top:24px;">Generated from the same audit trail and decision lineage as <code>context.json</code>, <code>metrics.json</code>, and <code>report.md</code> in this run's evidence directory.</p>
</div>
</body>
</html>`;
}
