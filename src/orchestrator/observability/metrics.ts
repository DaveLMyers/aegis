import type { AuditEvent } from '../types.js';

export interface RunMetrics {
  runId: string;
  totalStagesAttempted: number;
  stagesPassed: number;
  successRate: number;
  retryCount: number;
  rollbackCount: number;
  replanCount: number;
  mttrMs: number | null;
  totalLatencyMs: number;
}

/**
 * Derives the reliability metrics the assignment explicitly asks for
 * (success rate, retry/rollback frequency, MTTR, end-to-end latency) from the
 * audit trail -- computed, not hand-authored, so they reflect what actually
 * happened on a given run.
 */
export function computeMetrics(runId: string, events: AuditEvent[]): RunMetrics {
  const startEvent = events.find((e) => e.type === 'run-start');
  const endEvent = [...events].reverse().find((e) => e.type === 'run-end');
  const totalLatencyMs =
    startEvent && endEvent ? Date.parse(endEvent.ts) - Date.parse(startEvent.ts) : 0;

  const stagePasses = events.filter((e) => e.type === 'stage-pass');
  const stageFails = events.filter((e) => e.type === 'stage-fail');
  const attempted = new Set(events.filter((e) => e.type === 'stage-start').map((e) => e.stageId)).size;

  const retryCount = events.filter((e) => e.type === 'retry').length;
  const rollbackCount = events.filter((e) => e.type === 'rollback').length;
  const replanCount = events.filter((e) => e.type === 'replan').length;

  // MTTR: for each stage-fail, find the next stage-pass for the same stage and
  // average the recovery time across those pairs.
  const recoveryDurations: number[] = [];
  for (const fail of stageFails) {
    const recovery = events.find(
      (e) => e.type === 'stage-pass' && e.stageId === fail.stageId && Date.parse(e.ts) >= Date.parse(fail.ts),
    );
    if (recovery) {
      recoveryDurations.push(Date.parse(recovery.ts) - Date.parse(fail.ts));
    }
  }
  const mttrMs =
    recoveryDurations.length > 0
      ? recoveryDurations.reduce((a, b) => a + b, 0) / recoveryDurations.length
      : null;

  return {
    runId,
    totalStagesAttempted: attempted,
    stagesPassed: stagePasses.length,
    successRate: attempted > 0 ? stagePasses.length / attempted : 0,
    retryCount,
    rollbackCount,
    replanCount,
    mttrMs,
    totalLatencyMs,
  };
}
