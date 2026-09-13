import { spawnSync } from 'node:child_process';
import { requestApproval } from '../../approval.js';
import type { ProjectContext } from '../../state/projectContext.js';
import type { StageExecutionResult } from '../../types.js';
import type { StageExecutionOptions } from '../agent.js';

/** Strips ANSI color/formatting escape codes -- terminal output looks right in a terminal, but raw in a markdown file it's just garbage. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Shared across all three scenario types: actually runs the target-project
 * test suite via vitest and reports the real pass/fail outcome, rather than
 * declaring success. This is what "realism of outputs" hinges on -- a
 * simulated-failure demo run and a genuine implementation bug both surface
 * here identically.
 */
export async function testingPlaybook(
  _ctx: ProjectContext,
  io: StageExecutionOptions,
  projectRoot: string,
): Promise<StageExecutionResult> {
  if (io.simulateFailure) {
    throw new Error('simulated failure: test runner crashed before completion');
  }
  const result = spawnSync('npx', ['vitest', 'run', 'tests/target-project', '--reporter=dot'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    shell: true,
    // Belt-and-suspenders with stripAnsi() below: ask the subprocess not to
    // colorize in the first place, rather than only cleaning up after it.
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const passed = result.status === 0 && !result.error;
  const combined = stripAnsi(
    `${result.error ? `spawn error: ${result.error.message}\n` : ''}${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  ).trim();
  const summaryTail = combined.split('\n').slice(-15).join('\n') || (passed ? 'tests passed' : 'tests failed (no output captured)');

  return {
    outputs: { testsPassed: passed, testSummary: summaryTail },
    rationale: passed
      ? 'ran the target-project test suite via vitest against the freshly implemented code; all tests passed'
      : 'ran the target-project test suite via vitest; one or more tests failed',
  };
}

/**
 * Second human-approval checkpoint (Core Requirement 4 calls for
 * "checkpoints," plural, and Core Requirement 7 for "approvals," plural --
 * release-readiness alone was only one). This one gates the *plan*, not the
 * output: a human signs off on the task graph decomposition produced before
 * implementation spends any effort executing it. Shared by both agent modes
 * for the same reason releaseReadinessPlaybook is shared with ClaudeAgent --
 * an LLM should not self-approve its own plan any more than it should
 * self-report its own tests passing.
 */
export async function withDecompositionApproval(
  base: StageExecutionResult,
  io: StageExecutionOptions,
): Promise<StageExecutionResult> {
  const tasks = (base.outputs.tasks as Array<{ id: string; description: string }> | undefined) ?? [];
  const summary = `Task graph for decomposition (${tasks.length} task(s)):\n${tasks
    .map((t) => `  - ${t.id}: ${t.description}`)
    .join('\n')}`;

  let approved: boolean;
  let approvalNote: string;
  if (io.autoApprove) {
    approved = true;
    approvalNote =
      'auto-approved for a scripted/demo run (--auto-approve); a real rollout would require an interactive human sign-off on the plan before implementation begins';
  } else {
    approved = await requestApproval(summary);
    approvalNote = approved
      ? 'plan approved interactively by a human operator at the CLI'
      : 'plan rejected interactively by a human operator at the CLI -- implementation will not proceed';
  }

  return {
    ...base,
    outputs: { ...base.outputs, approved },
    rationale: `${base.rationale}; ${approvalNote}`,
  };
}

/**
 * Shared human-approval checkpoint. `--auto-approve` is what lets scenario
 * runs complete unattended for the captured evidence in scenarios/runs/, but
 * every approval -- auto or human -- is recorded explicitly in the audit
 * trail so it's never silently implied.
 */
export async function releaseReadinessPlaybook(
  ctx: ProjectContext,
  io: StageExecutionOptions,
  _projectRoot: string,
): Promise<StageExecutionResult> {
  if (io.simulateFailure) {
    throw new Error('simulated failure: release checklist service unavailable');
  }
  const testingRecord = ctx.latest('testing');
  const reviewRecord = ctx.latest('review');
  const reviewFindings = (reviewRecord?.outputs.reviewFindings as string[] | undefined) ?? [];
  const summary = `Release checklist for "${ctx.scenario.name}": tests ${
    testingRecord?.status === 'passed' ? 'PASSED' : 'NOT PASSED'
  }; independent review ${reviewRecord?.status === 'passed' ? 'PASSED' : 'NOT PASSED'}${
    reviewFindings.length > 0 ? ` (${reviewFindings.length} finding(s): ${reviewFindings.join('; ')})` : ''
  }.`;

  let approved: boolean;
  let rationale: string;
  if (io.autoApprove) {
    approved = true;
    rationale =
      'auto-approved for a scripted/demo run (--auto-approve); a real rollout would require an interactive human sign-off at this gate';
  } else {
    approved = await requestApproval(summary);
    rationale = approved
      ? 'approved interactively by a human operator at the CLI'
      : 'rejected interactively by a human operator at the CLI -- release blocked';
  }

  return {
    outputs: { approved, releaseSummary: summary },
    rationale,
  };
}
