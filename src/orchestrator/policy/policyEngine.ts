import { relative, resolve } from 'node:path';
import { APPROVED_TECH_STACK, checkTechStandards } from './techStandards.js';
import type { StageExecutionResult, StageId } from '../types.js';

/**
 * "block" fails the stage outright (same as a failed exit gate). "ask"
 * escalates to the same human-approval mechanism as the release-readiness
 * gate rather than failing automatically -- for checks (like a secret-scan
 * hit) that can legitimately be a false positive a human should look at,
 * not something that should always hard-fail a build.
 */
export type PolicySeverity = 'block' | 'ask';

export interface PolicyViolation {
  message: string;
  severity: PolicySeverity;
}

export type PolicyDecision = 'allow' | 'ask' | 'block';

export interface PolicyCheckResult {
  decision: PolicyDecision;
  violations: PolicyViolation[];
}

export interface PolicyContext {
  stageId: StageId;
  result: StageExecutionResult;
  testingStageStatus: 'passed' | 'failed' | 'unknown';
  projectRoot: string;
  allowedWriteDirs: string[];
  /** Actual file content written this attempt (from ChangeTracker.writtenContent()) -- what the secret scan needs, since generated code lives here, not in a stage's scalar `outputs`. */
  writtenFiles?: Array<{ path: string; content: string }>;
}

const SECRET_PATTERNS = [
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /api[_-]?key\s*[:=]\s*['"][a-z0-9]{16,}['"]/i,
  /sk-ant-[a-z0-9-]{10,}/i,
  /AKIA[0-9A-Z]{16}/,
];

/**
 * Fixed guardrail rule set, checked before every stage transition is allowed
 * to be recorded as passed. This is the "policy guardrails for security,
 * compliance, and change control" requirement made concrete rather than
 * asserted in prose.
 */
export class PolicyEngine {
  check(ctx: PolicyContext): PolicyCheckResult {
    const violations: PolicyViolation[] = [];

    for (const file of ctx.result.filesChanged ?? []) {
      const abs = resolve(ctx.projectRoot, file);
      const insideAllowed = ctx.allowedWriteDirs.some((dir) => {
        const rel = relative(resolve(ctx.projectRoot, dir), abs);
        return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/');
      });
      if (!insideAllowed) {
        violations.push({
          message: `change-control: "${file}" is outside allowed write directories (${ctx.allowedWriteDirs.join(', ')})`,
          severity: 'block',
        });
      }
    }

    if (ctx.stageId === 'release-readiness' && ctx.testingStageStatus !== 'passed') {
      violations.push({
        message: 'release-control: cannot reach release-readiness without a passed testing stage',
        severity: 'block',
      });
    }

    // Tech-standards compliance is an 'ask', not a 'block': an off-list
    // proposal isn't necessarily wrong, it's a deviation a human should
    // actually decide on -- with the design stage's own rationale (which,
    // for a genuine deviation, is expected to contain the trade-off
    // comparison) surfaced as the context for that decision.
    if (ctx.stageId === 'design') {
      const technologies = (ctx.result.outputs.technologies as string[] | undefined) ?? [];
      const check = checkTechStandards(technologies);
      if (!check.compliant && ctx.result.outputs.technologyApproved !== true) {
        violations.push({
          message: `tech-standards: proposed technologies (${check.nonCompliant.join(', ')}) are not on the approved list (${APPROVED_TECH_STACK.join(', ')}) -- design rationale: ${ctx.result.rationale}`,
          severity: 'ask',
        });
      }
    }

    // Scan both the stage's scalar outputs (design docs, rationale-adjacent
    // strings, etc.) AND the actual content of any files it wrote -- the
    // latter is where generated code lives, and scanning only `outputs`
    // would silently miss it entirely (outputs.filesChanged is just a list
    // of paths, never the content).
    const outputBlobs = Object.values(ctx.result.outputs).filter((v): v is string => typeof v === 'string');
    const fileBlobs = (ctx.writtenFiles ?? []).map((f) => f.content);
    for (const blob of [...outputBlobs, ...fileBlobs]) {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(blob)) {
          violations.push({
            message: `security: generated content matched a likely-secret pattern (${pattern}) -- could be a false positive, needs a human look`,
            severity: 'ask',
          });
        }
      }
    }

    const decision: PolicyDecision = violations.some((v) => v.severity === 'block')
      ? 'block'
      : violations.some((v) => v.severity === 'ask')
        ? 'ask'
        : 'allow';

    return { decision, violations };
  }
}
