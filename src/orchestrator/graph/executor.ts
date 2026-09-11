import { STAGE_GRAPH, downstreamOf, type StageNode } from './stageGraph.js';
import { ProjectContext } from '../state/projectContext.js';
import { AuditLog } from '../observability/auditLog.js';
import { PolicyEngine } from '../policy/policyEngine.js';
import { ChangeTracker } from '../resilience/rollback.js';
import { withRetry } from '../resilience/retry.js';
import { ReplanTracker } from '../replanner.js';
import { requestApproval } from '../approval.js';
import type { Agent } from '../agents/agent.js';
import type { RunOptions, StageExecutionResult, StageId, StageRecord, StageStatus } from '../types.js';

export interface RunResult {
  status: 'completed' | 'halted';
  haltedStage?: StageId;
}

interface StageOutcome {
  status: StageStatus;
  replan?: { stageId: StageId; reason: string };
}

/** Mutable, once-per-run flag so `--trigger-replan` fires exactly once even though the target stage necessarily runs again (at attempt 1) after the replan it caused. */
interface ReplanTriggerState {
  fired: boolean;
}

/**
 * A human explicitly declining an approval gate (e.g. "n" at the
 * release-readiness prompt) is a decision, not a transient failure --
 * retrying just re-asks the same question, and falling back to a degraded
 * playbook makes no sense for a checklist stage. Thrown instead of a plain
 * Error so `withRetry`'s `isTerminal` check can short-circuit straight to a
 * halt.
 */
class ApprovalRejectedError extends Error {
  constructor(
    public readonly result: StageExecutionResult,
    reason: string,
  ) {
    super(reason);
    this.name = 'ApprovalRejectedError';
  }
}

/** Demonstration hook for `--trigger-replan`: fires once, on the stage's first natural attempt, and only if the agent didn't already flag an invalidation itself. */
function applyReplanTrigger(
  node: StageNode,
  attempt: number,
  result: StageExecutionResult,
  options: RunOptions,
  state: ReplanTriggerState,
): StageExecutionResult {
  const trigger = options.triggerReplan;
  if (!trigger || state.fired || trigger.atStage !== node.id || attempt !== 1 || result.upstreamInvalidated) {
    return result;
  }
  state.fired = true;
  return {
    ...result,
    upstreamInvalidated: {
      stageId: trigger.targetStage,
      reason: `demonstration: --trigger-replan forced "${node.id}" to flag "${trigger.targetStage}" as invalidated`,
    },
  };
}

export async function executeGraph(
  ctx: ProjectContext,
  agent: Agent,
  options: RunOptions,
  audit: AuditLog,
  policy: PolicyEngine,
  projectRoot: string,
  allowedWriteDirs: string[],
): Promise<RunResult> {
  const replanTracker = new ReplanTracker(options.maxReplans);
  const replanTriggerState: ReplanTriggerState = { fired: false };
  const completed = new Set<StageId>();

  while (completed.size < STAGE_GRAPH.length) {
    const ready = STAGE_GRAPH.filter((n) => !completed.has(n.id) && n.dependsOn.every((d) => completed.has(d)));
    if (ready.length === 0) {
      return { status: 'halted' };
    }

    const outcomes = await Promise.all(
      ready.map((node) => runStage(node, ctx, agent, options, audit, policy, projectRoot, allowedWriteDirs, replanTriggerState)),
    );

    for (let i = 0; i < ready.length; i++) {
      const node = ready[i];
      const outcome = outcomes[i];

      if (outcome.status === 'halted') {
        return { status: 'halted', haltedStage: node.id };
      }

      completed.add(node.id);

      if (outcome.replan && replanTracker.canReplan(outcome.replan.stageId)) {
        replanTracker.recordReplan(outcome.replan.stageId);
        audit.record(
          'replan',
          { fromStage: node.id, targetStage: outcome.replan.stageId, reason: outcome.replan.reason },
          node.id,
        );
        // Deliberately NOT deleting the superseded records here: ctx.records
        // is append-only everywhere else, and `latest()` already returns the
        // newest record regardless of how much history precedes it -- so
        // preserving what was invalidated (and why, via the audit log's
        // 'replan' event) is what makes a replan visible in report.md
        // instead of leaving only a bare count behind.
        const toReRun = new Set<StageId>([outcome.replan.stageId, ...downstreamOf(outcome.replan.stageId)]);
        for (const id of toReRun) completed.delete(id);
      }
    }
  }

  return { status: 'completed' };
}

async function runStage(
  node: StageNode,
  ctx: ProjectContext,
  agent: Agent,
  options: RunOptions,
  audit: AuditLog,
  policy: PolicyEngine,
  projectRoot: string,
  allowedWriteDirs: string[],
  replanTriggerState: ReplanTriggerState,
): Promise<StageOutcome> {
  const entry = node.entryGate(ctx);
  if (!entry.ok) {
    audit.record('entry-gate-fail', { reason: entry.reason }, node.id);
    return { status: 'halted' };
  }

  const stageStartedAt = new Date().toISOString();
  const snapshotLabel = `${node.id}:${Date.now()}`;
  ctx.snapshot(snapshotLabel);
  const tracker = new ChangeTracker(projectRoot);

  const isTarget = options.injectFailureAt === node.id;
  const isHardFailure = isTarget && options.injectFailureSeverity === 'hard';

  let attempt = 0;
  let finalResult: StageExecutionResult | undefined;

  const checkGatesAndPolicy = async (result: StageExecutionResult) => {
    const exit = node.exitGate(ctx, result);
    if (!exit.ok) {
      audit.record('exit-gate-fail', { reason: exit.reason }, node.id);
      throw new Error(exit.reason);
    }
    const testingRecord = ctx.latest('testing');
    const testingStatus = testingRecord?.status === 'passed' ? 'passed' : testingRecord?.status === 'failed' ? 'failed' : 'unknown';
    const policyResult = policy.check({
      stageId: node.id,
      result,
      testingStageStatus: testingStatus,
      projectRoot,
      allowedWriteDirs,
      writtenFiles: tracker.writtenContent(),
    });
    const messages = policyResult.violations.map((v) => v.message);

    if (policyResult.decision === 'block') {
      audit.record('policy-violation', { violations: messages }, node.id);
      throw new Error(`policy violation: ${messages.join('; ')}`);
    }

    if (policyResult.decision === 'ask') {
      const summary = `Policy escalation for "${node.id}": ${messages.join('; ')}`;
      if (options.autoApprove) {
        audit.record('policy-ask-auto-approved', { violations: messages }, node.id);
      } else {
        const approved = await requestApproval(summary);
        audit.record(approved ? 'policy-ask-approved' : 'policy-ask-rejected', { violations: messages }, node.id);
        if (!approved) {
          throw new Error(`policy escalation rejected by human operator: ${messages.join('; ')}`);
        }
      }
    }
  };

  const primary = await withRetry(
    async () => {
      attempt++;
      audit.record('stage-start', { attempt }, node.id);
      const simulateFailure = isTarget && (isHardFailure || attempt === 1);
      const rawResult = await agent.execute(node.id, ctx, {
        tracker,
        simulateFailure,
        fallback: false,
        autoApprove: options.autoApprove,
      });
      const result = applyReplanTrigger(node, attempt, rawResult, options, replanTriggerState);
      if (node.requiresApproval && result.outputs.approved === false) {
        throw new ApprovalRejectedError(result, `${node.id} rejected by human operator`);
      }
      await checkGatesAndPolicy(result);
      finalResult = result;
      return result;
    },
    {
      maxAttempts: options.maxRetries,
      backoffMs: 25,
      onAttempt: (n, err) => audit.record('retry', { attempt: n, error: String(err) }, node.id),
      isTerminal: (err) => err instanceof ApprovalRejectedError,
    },
  );

  if (primary.ok) {
    return finalizeSuccess(node, ctx, audit, finalResult!, attempt, stageStartedAt);
  }

  if (primary.error instanceof ApprovalRejectedError) {
    return finalizeRejection(node, ctx, audit, tracker, snapshotLabel, primary.error, attempt, stageStartedAt);
  }

  audit.record('fallback', { reason: String(primary.error) }, node.id);
  try {
    attempt++;
    audit.record('stage-start', { attempt, fallback: true }, node.id);
    const result = await agent.execute(node.id, ctx, {
      tracker,
      simulateFailure: isHardFailure,
      fallback: true,
      autoApprove: options.autoApprove,
    });
    await checkGatesAndPolicy(result);
    return finalizeSuccess(node, ctx, audit, result, attempt, stageStartedAt);
  } catch (fallbackError) {
    audit.record('stage-fail', { error: String(fallbackError) }, node.id);
    audit.record('rollback', { snapshot: snapshotLabel }, node.id);
    const reverted = tracker.rollback();
    ctx.restore(snapshotLabel);
    ctx.append({
      stageId: node.id,
      attempt,
      startedAt: stageStartedAt,
      endedAt: new Date().toISOString(),
      status: 'failed',
      inputs: {},
      outputs: {},
      rationale: `stage failed after retries + fallback; rolled back ${reverted.length} file(s): ${String(fallbackError)}`,
      assumptions: [],
      filesChanged: [],
    });
    audit.record('safe-stop', { reason: String(fallbackError) }, node.id);
    return { status: 'halted' };
  }
}

function finalizeSuccess(
  node: StageNode,
  ctx: ProjectContext,
  audit: AuditLog,
  result: StageExecutionResult,
  attempt: number,
  stageStartedAt: string,
): StageOutcome {
  const record: StageRecord = {
    stageId: node.id,
    attempt,
    startedAt: stageStartedAt,
    endedAt: new Date().toISOString(),
    status: 'passed',
    inputs: {},
    outputs: result.outputs,
    rationale: result.rationale,
    assumptions: result.assumptions ?? [],
    filesChanged: result.filesChanged ?? [],
  };
  ctx.append(record);
  audit.record('stage-pass', { attempt, outputs: Object.keys(result.outputs) }, node.id);

  if (node.requiresApproval) {
    // Reaching here means the exit gate already passed, which for an
    // approval-requiring stage means `approved` was true -- a rejection
    // never gets this far (see ApprovalRejectedError / finalizeRejection).
    audit.record('approval-granted', {}, node.id);
  }

  if (result.upstreamInvalidated) {
    return { status: 'passed', replan: result.upstreamInvalidated };
  }
  return { status: 'passed' };
}

/**
 * A human explicitly rejected an approval gate -- halt immediately rather
 * than retrying/falling back (which would just re-ask the same question).
 * Still records a full StageRecord and restores any snapshot, but with
 * status `halted` and the actual rejection rationale, not a generic
 * "stage failed" -- this was a working decision, not a bug.
 */
function finalizeRejection(
  node: StageNode,
  ctx: ProjectContext,
  audit: AuditLog,
  tracker: ChangeTracker,
  snapshotLabel: string,
  error: ApprovalRejectedError,
  attempt: number,
  stageStartedAt: string,
): StageOutcome {
  audit.record('approval-rejected', { outputs: error.result.outputs }, node.id);
  const reverted = tracker.rollback();
  if (reverted.length > 0) {
    audit.record('rollback', { snapshot: snapshotLabel }, node.id);
  }
  ctx.restore(snapshotLabel);
  ctx.append({
    stageId: node.id,
    attempt,
    startedAt: stageStartedAt,
    endedAt: new Date().toISOString(),
    status: 'halted',
    inputs: {},
    outputs: error.result.outputs,
    rationale: error.result.rationale,
    assumptions: error.result.assumptions ?? [],
    filesChanged: error.result.filesChanged ?? [],
  });
  return { status: 'halted' };
}
