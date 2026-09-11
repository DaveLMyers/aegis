import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectContext } from '../../state/projectContext.js';
import type { StageExecutionResult } from '../../types.js';
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

  return {
    outputs: { reviewFindings: findings, reviewPassed: findings.length === 0 },
    rationale:
      findings.length === 0
        ? `independent review scanned ${files.length} changed file(s) (heuristic scan: empty files, TODO/FIXME/XXX markers) with no findings`
        : `independent review scanned ${files.length} changed file(s) and found ${findings.length} issue(s): ${findings.join('; ')}`,
  };
}
