import type { ScenarioDefinition, StageId, StageRecord } from '../types.js';

/**
 * ProjectContext is the shared, append-only record threaded through a run.
 * It IS the cross-stage decision lineage: every stage reads what came before
 * and appends its own outputs + rationale, rather than passing narrow
 * hand-picked arguments between steps.
 */
export class ProjectContext {
  readonly scenario: ScenarioDefinition;
  readonly runId: string;
  readonly startedAt: string;
  records: StageRecord[] = [];

  private snapshots = new Map<string, StageRecord[]>();

  constructor(scenario: ScenarioDefinition, runId: string) {
    this.scenario = scenario;
    this.runId = runId;
    this.startedAt = new Date().toISOString();
  }

  append(record: StageRecord): void {
    this.records.push(record);
  }

  /** Most recent record for a stage (there can be several across retries/replans). */
  latest(stageId: StageId): StageRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].stageId === stageId) return this.records[i];
    }
    return undefined;
  }

  hasPassed(stageId: StageId): boolean {
    return this.latest(stageId)?.status === 'passed';
  }

  snapshot(label: string): void {
    this.snapshots.set(label, this.records.map((r) => ({ ...r, outputs: { ...r.outputs } })));
  }

  restore(label: string): boolean {
    const snap = this.snapshots.get(label);
    if (!snap) return false;
    this.records = snap.map((r) => ({ ...r, outputs: { ...r.outputs } }));
    return true;
  }

  /** Drop all records for a stage and anything downstream of it, so it can be re-run. */
  invalidateFrom(stageId: StageId, downstreamOf: (id: StageId) => StageId[]): void {
    const toDrop = new Set<StageId>([stageId, ...downstreamOf(stageId)]);
    this.records = this.records.filter((r) => !toDrop.has(r.stageId));
  }

  toJSON() {
    return {
      runId: this.runId,
      scenario: this.scenario,
      startedAt: this.startedAt,
      records: this.records,
    };
  }
}
