import { spawnSync } from 'node:child_process';
import { requestApproval } from '../../approval.js';
import type { ProjectContext } from '../../state/projectContext.js';
import type { StageExecutionResult } from '../../types.js';
import type { StageExecutionOptions } from '../agent.js';

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
  });
  const passed = result.status === 0 && !result.error;
  const combined = `${result.error ? `spawn error: ${result.error.message}\n` : ''}${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const summaryTail = combined.split('\n').slice(-15).join('\n') || (passed ? 'tests passed' : 'tests failed (no output captured)');

  return {
    outputs: { testsPassed: passed, testSummary: summaryTail },
    rationale: passed
      ? 'ran the target-project test suite via vitest against the freshly implemented code; all tests passed'
      : 'ran the target-project test suite via vitest; one or more tests failed',
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
  const summary = `Release checklist for "${ctx.scenario.name}": tests ${
    testingRecord?.status === 'passed' ? 'PASSED' : 'NOT PASSED'
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
