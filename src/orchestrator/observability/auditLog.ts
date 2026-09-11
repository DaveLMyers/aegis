import { appendFileSync } from 'node:fs';
import type { AuditEvent, AuditEventType, StageId } from '../types.js';

/**
 * Append-only JSONL audit trail. Every stage transition, gate decision, retry,
 * rollback, and approval is one entry here -- this is the audit-grade
 * observability / decision-lineage requirement made concrete.
 */
export class AuditLog {
  private events: AuditEvent[] = [];
  constructor(private readonly filePath: string, private readonly runId: string) {}

  record(type: AuditEventType, details: Record<string, unknown> = {}, stageId?: StageId): AuditEvent {
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      runId: this.runId,
      type,
      stageId,
      details,
    };
    this.events.push(event);
    appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf-8');
    return event;
  }

  all(): AuditEvent[] {
    return this.events;
  }
}
