import { alwaysOk, requireOutputKeys, requireOutputTrue, requireStagesPassed, allOf } from '../gates/gate.js';
import type { GateResult, ProjectContextLike, StageExecutionResult } from '../gates/gateTypes.js';
import type { StageId } from '../types.js';

export interface StageNode {
  id: StageId;
  dependsOn: StageId[];
  parallelGroup?: string;
  requiresApproval?: boolean;
  entryGate: (ctx: ProjectContextLike) => GateResult;
  exitGate: (ctx: ProjectContextLike, result: StageExecutionResult) => GateResult;
}

/**
 * The canonical SDLC stage graph. `implementation` and `test-authoring` share
 * the same upstream dependency (`design`) and no dependency on each other, so
 * the executor runs them concurrently and `testing` is the synchronization
 * point that waits on both -- the required sequential+parallel-with-sync shape.
 */
export const STAGE_GRAPH: StageNode[] = [
  {
    id: 'requirements',
    dependsOn: [],
    entryGate: alwaysOk,
    exitGate: requireOutputKeys(['normalizedRequirement', 'assumptions']),
  },
  {
    id: 'design',
    dependsOn: ['requirements'],
    entryGate: requireStagesPassed(['requirements']),
    // Tech-standards compliance is deliberately NOT a hard gate here -- it's
    // a PolicyEngine 'ask' rule instead, so an off-list proposal escalates
    // to a human approval prompt (with the design stage's own trade-off
    // reasoning as context) rather than just failing the stage outright.
    exitGate: requireOutputKeys(['designDoc', 'impactedModules', 'technologies']),
  },
  {
    id: 'implementation',
    dependsOn: ['design'],
    parallelGroup: 'build',
    entryGate: requireStagesPassed(['design']),
    exitGate: requireOutputKeys(['filesChanged']),
  },
  {
    id: 'test-authoring',
    dependsOn: ['design'],
    parallelGroup: 'build',
    entryGate: requireStagesPassed(['design']),
    exitGate: requireOutputKeys(['testFilesChanged']),
  },
  {
    id: 'testing',
    dependsOn: ['implementation', 'test-authoring'],
    entryGate: requireStagesPassed(['implementation', 'test-authoring']),
    exitGate: allOf(requireOutputKeys(['testsPassed', 'testSummary']), (_ctx, result) =>
      result.outputs.testsPassed === true
        ? { ok: true, reason: 'tests passed' }
        : { ok: false, reason: `tests failed: ${String(result.outputs.testSummary ?? 'unknown')}` },
    ),
  },
  {
    id: 'review',
    dependsOn: ['testing'],
    // Deliberately independent of `implementation`/`design` -- it depends
    // only on `testing` having passed, and the playbook behind it never
    // reads those stages' rationale, only the actual file content produced.
    // See agents/playbooks/review.ts.
    entryGate: requireStagesPassed(['testing']),
    exitGate: allOf(requireOutputKeys(['reviewFindings', 'reviewPassed']), requireOutputTrue('reviewPassed')),
  },
  {
    id: 'documentation',
    dependsOn: ['review'],
    entryGate: requireStagesPassed(['review']),
    exitGate: requireOutputKeys(['docsChanged']),
  },
  {
    id: 'release-readiness',
    dependsOn: ['documentation'],
    requiresApproval: true,
    entryGate: requireStagesPassed(['documentation']),
    exitGate: allOf(requireOutputKeys(['approved']), requireOutputTrue('approved')),
  },
];

export function downstreamOf(stageId: StageId): StageId[] {
  const direct = STAGE_GRAPH.filter((n) => n.dependsOn.includes(stageId)).map((n) => n.id);
  const transitive = direct.flatMap((id) => downstreamOf(id));
  return Array.from(new Set([...direct, ...transitive]));
}
