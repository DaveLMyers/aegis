import type { StageId, StageRecord, StageExecutionResult, GateResult } from '../types.js';

/** Narrow view of ProjectContext that gates depend on -- keeps gate logic independent of state internals. */
export interface ProjectContextLike {
  hasPassed(stageId: StageId): boolean;
  latest(stageId: StageId): StageRecord | undefined;
}

export type { StageId, StageExecutionResult, GateResult };
