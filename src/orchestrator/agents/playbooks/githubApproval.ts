import { spawnSync } from 'node:child_process';
import type { ProjectContext } from '../../state/projectContext.js';
import type { StageExecutionResult } from '../../types.js';
import type { StageExecutionOptions } from '../agent.js';

const POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function run(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Every file any stage in this run touched, deduplicated -- what gets committed for review. */
export function collectChangedFiles(ctx: ProjectContext): string[] {
  return Array.from(new Set(ctx.records.flatMap((r) => r.filesChanged)));
}

export function buildPrBody(ctx: ProjectContext): string {
  const lines: string[] = [];
  lines.push(`AEGIS-proposed change for scenario "${ctx.scenario.name}" (${ctx.scenario.type}).`);
  lines.push('');
  lines.push(`**Requirement:** ${ctx.scenario.requirementText}`);
  lines.push('');
  for (const record of ctx.records) {
    lines.push(`### ${record.stageId} (${record.status})`);
    lines.push(record.rationale);
    if (record.assumptions.length > 0) lines.push(`Assumptions: ${record.assumptions.join('; ')}`);
    lines.push('');
  }
  lines.push('---');
  lines.push(
    'Opened automatically by AEGIS. Merging this PR **is** the human-approval action for the ' +
      '`release-readiness` gate -- the run is watching for the merge and will complete once it ' +
      'happens. Closing without merging is a rejection and will trigger the same rollback path a ' +
      'failed gate would.',
  );
  return lines.join('\n');
}

/**
 * Alternative to the CLI-prompt release-readiness playbook: the human
 * approval action is a real GitHub PR merge, not a terminal keypress.
 * Requires `projectRoot` to be a git repo with a GitHub remote `gh` can push
 * to -- designed for `--target-repo` pointed at an actual GitHub URL, not
 * for demoing against AEGIS's own repo (that risks tangling with whatever
 * branch AEGIS's own development happens to be on).
 */
export async function githubReleaseReadinessPlaybook(
  ctx: ProjectContext,
  io: StageExecutionOptions,
  projectRoot: string,
): Promise<StageExecutionResult> {
  if (io.simulateFailure) {
    throw new Error('simulated failure: release checklist service unavailable');
  }

  const changedFiles = collectChangedFiles(ctx);
  if (changedFiles.length === 0) {
    return {
      outputs: { approved: true, releaseSummary: 'no files changed this run; nothing to open a PR for' },
      rationale: 'no file changes were produced by this run -- trivially approved rather than opening an empty PR',
    };
  }

  const originalBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot).stdout.trim();
  const branchName = `aegis/run-${ctx.runId}`;

  const checkout = run('git', ['checkout', '-b', branchName], projectRoot);
  if (checkout.status !== 0) {
    throw new Error(`github-pr release: failed to create branch "${branchName}": ${checkout.stderr}`);
  }

  const add = run('git', ['add', ...changedFiles], projectRoot);
  if (add.status !== 0) {
    run('git', ['checkout', originalBranch], projectRoot);
    throw new Error(`github-pr release: git add failed: ${add.stderr}`);
  }

  const commitMessage = `AEGIS: ${ctx.scenario.requirementText}\n\nScenario: ${ctx.scenario.name} (${ctx.scenario.type})\nRun: ${ctx.runId}`;
  const commit = run('git', ['commit', '-m', commitMessage], projectRoot);
  if (commit.status !== 0) {
    run('git', ['checkout', originalBranch], projectRoot);
    throw new Error(`github-pr release: git commit failed: ${commit.stderr}`);
  }

  const push = run('git', ['push', '-u', 'origin', branchName], projectRoot);
  if (push.status !== 0) {
    run('git', ['checkout', originalBranch], projectRoot);
    throw new Error(`github-pr release: git push failed: ${push.stderr}`);
  }

  const title = `AEGIS: ${ctx.scenario.name} -- ${ctx.scenario.requirementText}`.slice(0, 200);
  const prCreate = run('gh', ['pr', 'create', '--title', title, '--body', buildPrBody(ctx), '--head', branchName], projectRoot);
  if (prCreate.status !== 0) {
    run('git', ['checkout', originalBranch], projectRoot);
    throw new Error(`github-pr release: gh pr create failed: ${prCreate.stderr}`);
  }
  const prUrl = prCreate.stdout.trim().split('\n').pop() ?? '';
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  if (!prNumber) {
    throw new Error(`github-pr release: could not determine PR number from gh output: "${prCreate.stdout}"`);
  }

  const timeoutMs = Number(process.env.AEGIS_PR_POLL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let finalState: 'MERGED' | 'CLOSED' | 'TIMEOUT' = 'TIMEOUT';

  while (Date.now() < deadline) {
    const view = run('gh', ['pr', 'view', prNumber, '--json', 'state,mergedAt'], projectRoot);
    if (view.status === 0) {
      const data = JSON.parse(view.stdout) as { state: string; mergedAt: string | null };
      if (data.state === 'MERGED') {
        finalState = 'MERGED';
        break;
      }
      if (data.state === 'CLOSED') {
        finalState = 'CLOSED';
        break;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  run('git', ['checkout', originalBranch], projectRoot);

  if (finalState === 'MERGED') {
    return {
      outputs: { approved: true, releaseSummary: `approved via GitHub PR ${prUrl} (merged)`, prUrl },
      rationale: `a human merged PR ${prUrl} -- that merge IS the release-readiness approval, not a simulated one`,
    };
  }

  // Rejected (closed without merging) or timed out -- clean up so repeated
  // demo runs don't leave a trail of abandoned branches/PRs behind.
  run('gh', ['pr', 'close', prNumber], projectRoot);
  run('git', ['push', 'origin', '--delete', branchName], projectRoot);

  return {
    outputs: {
      approved: false,
      releaseSummary:
        finalState === 'CLOSED'
          ? `PR ${prUrl} was closed without merging -- release rejected`
          : `timed out after ${timeoutMs}ms waiting for PR ${prUrl} to be merged -- release rejected`,
    },
    rationale:
      finalState === 'CLOSED'
        ? 'a human closed the PR without merging it -- treated as an explicit rejection, same as a "n" at the CLI prompt'
        : 'no merge decision was made within the poll timeout -- treated as a rejection rather than hanging indefinitely',
  };
}
