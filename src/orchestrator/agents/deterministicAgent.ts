import type { ProjectContext } from '../state/projectContext.js';
import type { ScenarioType, StageExecutionResult, StageId } from '../types.js';
import type { Agent, StageExecutionOptions } from './agent.js';
import { greenfieldPlaybooks } from './playbooks/greenfield.js';
import { brownfieldPlaybooks } from './playbooks/brownfield.js';
import { ambiguousPlaybooks } from './playbooks/ambiguous.js';
import { releaseReadinessPlaybook, testingPlaybook } from './playbooks/common.js';
import { githubReleaseReadinessPlaybook } from './playbooks/githubApproval.js';

type PlaybookFn = (ctx: ProjectContext, io: StageExecutionOptions, projectRoot: string) => Promise<StageExecutionResult> | StageExecutionResult;

const SCENARIO_PLAYBOOKS: Record<ScenarioType, Partial<Record<StageId, PlaybookFn>>> = {
  greenfield: {
    requirements: greenfieldPlaybooks.requirements,
    design: greenfieldPlaybooks.design,
    implementation: greenfieldPlaybooks.implementation,
    'test-authoring': greenfieldPlaybooks.testAuthoring,
    documentation: greenfieldPlaybooks.documentation,
  },
  brownfield: {
    requirements: brownfieldPlaybooks.requirements,
    design: brownfieldPlaybooks.design,
    implementation: brownfieldPlaybooks.implementation,
    'test-authoring': brownfieldPlaybooks.testAuthoring,
    documentation: brownfieldPlaybooks.documentation,
  },
  ambiguous: {
    requirements: ambiguousPlaybooks.requirements,
    design: ambiguousPlaybooks.design,
    implementation: ambiguousPlaybooks.implementation,
    'test-authoring': ambiguousPlaybooks.testAuthoring,
    documentation: ambiguousPlaybooks.documentation,
  },
  // No deterministic playbooks for ad-hoc requirements -- by design. An
  // arbitrary requirement has no known-good template; it correctly throws
  // below rather than pretending to handle it. AGENT_MODE=llm is the actual
  // path for this scenario type.
  adhoc: {},
};

// Shared across every scenario type regardless of what's scenario-specific above.
const SHARED_PLAYBOOKS: Partial<Record<StageId, PlaybookFn>> = {
  testing: testingPlaybook,
  'release-readiness': releaseReadinessPlaybook,
};

/**
 * Default agent implementation: dispatches each stage to a pre-authored,
 * known-good playbook rather than synthesizing code at run time. This is a
 * deliberate trade-off -- see docs/final-engineering-summary.md -- traded for
 * an agent that is offline, free, and 100% reproducible for anyone grading
 * this. `ClaudeAgent` is the pluggable alternative for genuine generation.
 */
export class DeterministicAgent implements Agent {
  readonly mode = 'deterministic' as const;
  constructor(
    private readonly projectRoot: string,
    private readonly releaseVia: 'cli' | 'github-pr' = 'cli',
  ) {}

  async execute(stageId: StageId, ctx: ProjectContext, io: StageExecutionOptions): Promise<StageExecutionResult> {
    if (stageId === 'release-readiness' && this.releaseVia === 'github-pr' && !io.autoApprove) {
      return githubReleaseReadinessPlaybook(ctx, io, this.projectRoot);
    }
    const playbook = SHARED_PLAYBOOKS[stageId] ?? SCENARIO_PLAYBOOKS[ctx.scenario.type][stageId];
    if (!playbook) {
      throw new Error(`no deterministic playbook registered for scenario "${ctx.scenario.type}" stage "${stageId}"`);
    }
    return playbook(ctx, io, this.projectRoot);
  }
}
