import type { StageId } from './types.js';

/**
 * Bounds how many times any single stage may trigger a re-plan, so a bad
 * upstream assumption can be corrected without risking an infinite
 * requirements<->testing loop.
 */
export class ReplanTracker {
  private counts = new Map<StageId, number>();
  constructor(private readonly maxReplans: number) {}

  canReplan(stageId: StageId): boolean {
    return (this.counts.get(stageId) ?? 0) < this.maxReplans;
  }

  recordReplan(stageId: StageId): void {
    this.counts.set(stageId, (this.counts.get(stageId) ?? 0) + 1);
  }
}
