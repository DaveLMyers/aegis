import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../src/orchestrator/observability/metrics.js';
import { STAGE_GRAPH } from '../../src/orchestrator/graph/stageGraph.js';
import type { AuditEvent } from '../../src/orchestrator/types.js';

function event(partial: Partial<AuditEvent> & Pick<AuditEvent, 'type'>): AuditEvent {
  return { ts: new Date().toISOString(), runId: 'run-1', details: {}, ...partial };
}

describe('computeMetrics', () => {
  it('denominates success rate on the full graph size, not stages-attempted', () => {
    // A run that only ever starts 3 of the 8 real stages before halting must
    // not report 100% just because everything it attempted happened to pass
    // -- that flatters a run that died partway through.
    const events: AuditEvent[] = [
      event({ type: 'run-start' }),
      event({ type: 'stage-start', stageId: 'requirements' }),
      event({ type: 'stage-pass', stageId: 'requirements' }),
      event({ type: 'stage-start', stageId: 'design' }),
      event({ type: 'stage-pass', stageId: 'design' }),
      event({ type: 'stage-start', stageId: 'implementation' }),
      event({ type: 'stage-pass', stageId: 'implementation' }),
      event({ type: 'run-end' }),
    ];
    const metrics = computeMetrics('run-1', events);
    expect(metrics.totalStagesAttempted).toBe(3);
    expect(metrics.stagesPassed).toBe(3);
    expect(metrics.successRate).toBeCloseTo(3 / STAGE_GRAPH.length);
    expect(metrics.successRate).toBeLessThan(1);
  });

  it('computes a real MTTR when a stage-fail is followed by a later stage-pass for the same stage', () => {
    // This is the shape that now exists after primary-exhaustion emits its
    // own 'stage-fail' -- a stage that recovers via fallback has exactly
    // this pair in the audit trail.
    const t0 = Date.now();
    const events: AuditEvent[] = [
      event({ type: 'run-start', ts: new Date(t0).toISOString() }),
      event({ type: 'stage-fail', stageId: 'design', ts: new Date(t0).toISOString() }),
      event({ type: 'stage-pass', stageId: 'design', ts: new Date(t0 + 500).toISOString() }),
      event({ type: 'run-end', ts: new Date(t0 + 500).toISOString() }),
    ];
    const metrics = computeMetrics('run-1', events);
    expect(metrics.mttrMs).toBe(500);
  });

  it('reports null MTTR when a stage-fail is never followed by a recovery (run halted)', () => {
    const events: AuditEvent[] = [
      event({ type: 'run-start' }),
      event({ type: 'stage-fail', stageId: 'implementation' }),
      event({ type: 'safe-stop', stageId: 'implementation' }),
      event({ type: 'run-end' }),
    ];
    const metrics = computeMetrics('run-1', events);
    expect(metrics.mttrMs).toBeNull();
  });
});
