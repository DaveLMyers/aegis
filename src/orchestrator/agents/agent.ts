import type { ProjectContext } from '../state/projectContext.js';
import type { ChangeTracker } from '../resilience/rollback.js';
import type { StageExecutionResult, StageId } from '../types.js';

export interface StageExecutionOptions {
  /** File-write tracking so a rollback can revert exactly what this stage attempt changed. */
  tracker: ChangeTracker;
  /** True when this specific attempt should simulate a failure (used to exercise resilience paths). */
  simulateFailure: boolean;
  /** True when the primary attempt(s) already failed and this is the degraded fallback attempt. */
  fallback: boolean;
  /** Whether the run should auto-approve the human-approval gate rather than prompting interactively. */
  autoApprove: boolean;
}

/**
 * Everything the orchestration engine knows about "how a stage's work gets done"
 * goes through this interface. The engine (graph, gates, resilience, policy,
 * observability) is entirely agnostic to which implementation is behind it --
 * that's what makes the deterministic-vs-real-LLM choice a pluggable backend
 * rather than a fork of the orchestrator itself.
 */
export interface Agent {
  readonly mode: 'deterministic' | 'llm';
  execute(stageId: StageId, ctx: ProjectContext, options: StageExecutionOptions): Promise<StageExecutionResult>;
}
