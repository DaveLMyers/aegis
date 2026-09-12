import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectContext } from '../../state/projectContext.js';
import type { StageExecutionResult, UpstreamInvalidation } from '../../types.js';
import type { StageExecutionOptions } from '../agent.js';
import { collectChangedFiles } from './githubApproval.js';

/** Reads the actual content of every file this run changed -- what an independent reviewer needs, not a list of paths. */
export function readChangedFiles(ctx: ProjectContext, projectRoot: string): Array<{ path: string; content: string }> {
  return collectChangedFiles(ctx)
    .map((p) => {
      const abs = resolve(projectRoot, p);
      return existsSync(abs) ? { path: p, content: readFileSync(abs, 'utf-8') } : null;
    })
    .filter((f): f is { path: string; content: string } => f !== null);
}

/**
 * Turns a review finding into a real re-plan request rather than letting it
 * cascade into the retry/fallback/rollback chain built for technical
 * failures. Shared by both agent modes so the actual "what happens when
 * review finds a real problem" decision lives in exactly one tested place.
 *
 * `reviewPassed: false` -- "a genuine blocking problem, not a style nit"
 * (see the LLM review prompt in claudeAgent.ts) -- is what sends the run
 * back to `implementation`, bounded by `maxReplans` in the executor: if the
 * budget is exhausted and a finding still exists, the run proceeds anyway
 * with the finding intact in this stage's record, surfaced to the human at
 * `release-readiness` rather than silently discarded or endlessly retried.
 */
export function reviewFindingsToInvalidation(reviewPassed: boolean, findings: string[]): UpstreamInvalidation | undefined {
  if (reviewPassed || findings.length === 0) return undefined;
  return {
    stageId: 'implementation',
    reason: `independent review found ${findings.length} blocking issue(s), sending the run back to implementation: ${findings.join('; ')}`,
  };
}

const SUSPECT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTODO\b/, label: 'contains a TODO marker' },
  { pattern: /\bFIXME\b/, label: 'contains a FIXME marker' },
  { pattern: /\bXXX\b/, label: 'contains an XXX marker' },
];

/**
 * The independent review stage, deliberately isolated from the implementer:
 * it never sees `design`/`implementation`'s own rationale, only the actual
 * file content that was produced -- the same discipline a human reviewer
 * with fresh eyes applies, so a shared blind spot between "wrote it" and
 * "tested it" has something else in the loop to catch it.
 *
 * For the deterministic agent this is necessarily a lightweight heuristic
 * scan -- the playbooks are pre-vetted templates, so there's nothing
 * genuinely novel to discover. `ClaudeAgent`'s dedicated review prompt (see
 * claudeAgent.ts) is where this stage does real independent reasoning.
 */
export function deterministicReviewPlaybook(
  ctx: ProjectContext,
  io: StageExecutionOptions,
  projectRoot: string,
): StageExecutionResult {
  if (io.simulateFailure) {
    throw new Error('simulated failure: review service unavailable');
  }

  const files = readChangedFiles(ctx, projectRoot);
  const findings: string[] = [];
  for (const file of files) {
    if (file.content.trim().length === 0) {
      findings.push(`${file.path}: file is empty`);
      continue;
    }
    for (const { pattern, label } of SUSPECT_PATTERNS) {
      if (pattern.test(file.content)) {
        findings.push(`${file.path}: ${label}`);
      }
    }
  }

  const reviewPassed = findings.length === 0;
  return {
    outputs: { reviewFindings: findings, reviewPassed },
    rationale: reviewPassed
      ? `independent review scanned ${files.length} changed file(s) (heuristic scan: empty files, TODO/FIXME/XXX markers) with no findings`
      : `independent review scanned ${files.length} changed file(s) and found ${findings.length} issue(s): ${findings.join('; ')}`,
    upstreamInvalidated: reviewFindingsToInvalidation(reviewPassed, findings),
  };
}
