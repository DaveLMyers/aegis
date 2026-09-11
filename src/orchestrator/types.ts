export type StageId =
  | 'requirements'
  | 'design'
  | 'implementation'
  | 'test-authoring'
  | 'testing'
  | 'documentation'
  | 'release-readiness';

export type StageStatus = 'pending' | 'running' | 'passed' | 'failed' | 'halted' | 'skipped';

export type ScenarioType = 'greenfield' | 'brownfield' | 'ambiguous' | 'adhoc';

export interface ScenarioDefinition {
  name: string;
  type: ScenarioType;
  requirementText: string;
  /** Optional: force a simulated failure the first time this stage runs, to exercise the resilience chain. */
  injectFailureAt?: StageId;
}

export interface RunOptions {
  autoApprove: boolean;
  agentMode: 'deterministic' | 'llm';
  injectFailureAt?: StageId;
  /** "transient" fails only the first attempt (retry recovers it). "hard" fails every attempt including the fallback (forces rollback + safe-stop). */
  injectFailureSeverity?: 'transient' | 'hard';
  maxRetries: number;
  maxReplans: number;
}

export interface StageRecord {
  stageId: StageId;
  attempt: number;
  startedAt: string;
  endedAt?: string;
  status: StageStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  rationale: string;
  assumptions: string[];
  filesChanged: string[];
}

export interface UpstreamInvalidation {
  stageId: StageId;
  reason: string;
}

export interface StageExecutionResult {
  outputs: Record<string, unknown>;
  rationale: string;
  assumptions?: string[];
  filesChanged?: string[];
  upstreamInvalidated?: UpstreamInvalidation;
}

export interface GateResult {
  ok: boolean;
  reason: string;
}

export type AuditEventType =
  | 'stage-start'
  | 'stage-pass'
  | 'stage-fail'
  | 'entry-gate-fail'
  | 'exit-gate-fail'
  | 'retry'
  | 'fallback'
  | 'rollback'
  | 'safe-stop'
  | 'replan'
  | 'approval-requested'
  | 'approval-granted'
  | 'policy-violation'
  | 'policy-ask-auto-approved'
  | 'policy-ask-approved'
  | 'policy-ask-rejected'
  | 'run-start'
  | 'run-end';

export interface AuditEvent {
  ts: string;
  runId: string;
  type: AuditEventType;
  stageId?: StageId;
  details: Record<string, unknown>;
}
