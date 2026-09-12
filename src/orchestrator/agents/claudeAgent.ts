import Anthropic from '@anthropic-ai/sdk';
import type { ProjectContext } from '../state/projectContext.js';
import type { StageExecutionOptions } from './agent.js';
import type { StageExecutionResult, StageId } from '../types.js';
import type { Agent } from './agent.js';
import { listProjectFiles } from './codebaseSnapshot.js';
import { releaseReadinessPlaybook, testingPlaybook } from './playbooks/common.js';
import { githubReleaseReadinessPlaybook } from './playbooks/githubApproval.js';
import { readChangedFiles, reviewFindingsToInvalidation } from './playbooks/review.js';
import { APPROVED_TECH_STACK } from '../policy/techStandards.js';

const MODEL = 'claude-sonnet-5';

const STAGE_OUTPUT_CONTRACTS: Record<StageId, string> = {
  requirements: 'normalizedRequirement (string), assumptions (string[])',
  decomposition: 'tasks (array of { id: string, description: string, dependsOn: string[], acceptanceCriteria: string }) -- a real work breakdown of the normalized requirement, not the SDLC lifecycle; every dependsOn id must reference another task in the same array, no cycles',
  design: 'designDoc (string), impactedModules (string[]), technologies (string[])',
  implementation: 'filesChanged (string[], must match the paths given in "files")',
  'test-authoring': 'testFilesChanged (string[], must match the paths given in "files")',
  testing: 'testsPassed (boolean), testSummary (string)',
  review: 'reviewFindings (string[]), reviewPassed (boolean)', // handled by reviewStage() directly, never reaches the generic prompt -- kept for type completeness
  documentation: 'docsChanged (string[], must match the paths given in "files")',
  'release-readiness': 'approved (boolean)',
};

/**
 * Optional, pluggable alternative to DeterministicAgent: makes a real call to
 * the Anthropic API per stage and uses the live response as the stage's
 * output, for demonstrating genuine LLM-driven reasoning on an arbitrary
 * requirement (`AGENT_MODE=llm`) -- deliberately domain-agnostic, since this
 * is the path meant to prove AEGIS isn't hardcoded to one problem.
 */
export class ClaudeAgent implements Agent {
  readonly mode = 'llm' as const;
  private readonly client: Anthropic;

  constructor(
    private readonly projectRoot: string,
    private readonly releaseVia: 'cli' | 'github-pr' = 'cli',
  ) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('AGENT_MODE=llm requires ANTHROPIC_API_KEY to be set');
    }
    // Explicit rather than relying on the SDK default -- a hung request
    // should occupy at most one bounded retry attempt, not tie up a stage
    // indefinitely.
    this.client = new Anthropic({ apiKey, timeout: 30_000 });
  }

  async execute(stageId: StageId, ctx: ProjectContext, io: StageExecutionOptions): Promise<StageExecutionResult> {
    // `testing` and `release-readiness` are validation/governance stages, not
    // creative ones -- they stay on the same real mechanisms regardless of
    // which agent is generating code. Letting the model self-report
    // "testsPassed: true" or self-approve its own release would make those
    // gates theater; delegating to the shared playbooks (real vitest run,
    // real human-approval prompt) keeps them real under either agent mode.
    if (stageId === 'testing') return testingPlaybook(ctx, io, this.projectRoot);
    if (stageId === 'release-readiness') {
      return this.releaseVia === 'github-pr' && !io.autoApprove
        ? githubReleaseReadinessPlaybook(ctx, io, this.projectRoot)
        : releaseReadinessPlaybook(ctx, io, this.projectRoot);
    }
    // `review` gets a real, separate LLM call -- unlike testing/release-readiness
    // it's still genuinely generative (that's the point), just deliberately
    // walled off from the implementer's own reasoning. See reviewStage() below.
    if (stageId === 'review') return this.reviewStage(ctx, io);

    if (io.simulateFailure) {
      throw new Error('simulated failure (llm agent, injected for resilience demonstration)');
    }

    const priorLineage = ctx.records.map((r) => `- ${r.stageId} (${r.status}): ${r.rationale}`).join('\n');

    // Real codebase awareness (Core Requirement 3) -- paths only, not
    // content, so an arbitrary --target-repo doesn't blow up the prompt.
    const fileTree = listProjectFiles(this.projectRoot);
    const fileTreeBlock =
      fileTree.length > 0
        ? `Existing files in the target project (path only -- ask for a file's content in your rationale if you need to reason about it, but you cannot request it mid-turn, so use path names and directory structure to infer intent):\n${fileTree.map((f) => `- ${f}`).join('\n')}`
        : '(target project is currently empty -- this is a greenfield build)';

    // Design is where technology gets chosen, so it's the one stage that
    // gets the approved-standards list up front, plus explicit instructions
    // for the case where the requirement doesn't fit it -- rather than
    // discovering the deviation only after the policy engine rejects it.
    const techStandardsBlock =
      stageId === 'design'
        ? `\nApproved technology standards (prefer these; a project already exists on this stack): ${APPROVED_TECH_STACK.join(', ')}.
If the requirement can reasonably be met using only the approved list, use only those -- do not
introduce a new technology just because it's a plausible choice in the abstract. If it genuinely
cannot (the requirement needs a capability none of the approved list provides), propose 2-3
concrete alternatives in your rationale, each with a one-sentence trade-off, explain specifically
why the approved list falls short, and state which alternative you're choosing and why. This will
be routed to a human for approval since it deviates from standards -- your rationale is what they
will read to decide, so make the trade-off reasoning complete, not just a technology name.\n`
        : '';

    const prompt = `You are the "${stageId}" stage of a governed SDLC orchestration engine. Do not assume any
particular domain, language, or framework beyond what the requirement, prior lineage, and the
existing file tree below actually imply.

Requirement: ${ctx.scenario.requirementText}

Prior stage lineage:
${priorLineage || '(none yet)'}

${fileTreeBlock}
${techStandardsBlock}
Respond with ONLY a JSON object (no markdown fences) of the shape:
{
  "rationale": string,
  "assumptions": string[],
  "outputs": object,
  "files": [{ "path": string, "content": string }]
}

"files" is how you actually produce artifacts -- include one entry per file you are creating or
changing, with its full new content. Only stages that produce artifacts (implementation,
test-authoring, documentation) need "files"; others may omit it or leave it empty. If the file
tree above shows this is a brownfield change, base new file content on reasonable inferences from
existing file names/paths rather than assuming a structure that contradicts them.

"outputs" must satisfy this stage's contract:
${stageId}: ${STAGE_OUTPUT_CONTRACTS[stageId]}`;

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('llm agent: no text content in response');
    }
    const parsed = JSON.parse(textBlock.text) as {
      rationale?: string;
      assumptions?: string[];
      outputs?: Record<string, unknown>;
      files?: Array<{ path: string; content: string }>;
    };

    const files = parsed.files ?? [];
    for (const file of files) {
      io.tracker.writeFile(file.path, file.content);
    }
    const filesChanged = files.map((f) => f.path);

    // Safety net: fill in the stage-appropriate output key from the files
    // list if the model produced files but forgot to name them in outputs.
    const outputs = { ...(parsed.outputs ?? {}) };
    const outputKeyByStage: Partial<Record<StageId, string>> = {
      implementation: 'filesChanged',
      'test-authoring': 'testFilesChanged',
      documentation: 'docsChanged',
    };
    const key = outputKeyByStage[stageId];
    if (key && filesChanged.length > 0 && !(key in outputs)) {
      outputs[key] = filesChanged;
    }

    return {
      outputs,
      rationale: parsed.rationale ?? '(no rationale returned by the model)',
      assumptions: parsed.assumptions ?? [],
      filesChanged,
    };
  }

  /**
   * Deliberately independent review: this prompt gets the requirement and
   * the actual file *content* the run produced, and nothing else -- no
   * design rationale, no implementation reasoning, no prior stage lineage.
   * The point is a second, genuinely separate pass that doesn't inherit
   * whatever blind spot the implementer had, the same reason a human
   * reviewer works from the diff, not the author's explanation of it.
   */
  private async reviewStage(ctx: ProjectContext, io: StageExecutionOptions): Promise<StageExecutionResult> {
    if (io.simulateFailure) {
      throw new Error('simulated failure (llm agent, injected for resilience demonstration)');
    }

    const files = readChangedFiles(ctx, this.projectRoot);
    if (files.length === 0) {
      return {
        outputs: { reviewFindings: [], reviewPassed: true },
        rationale: 'no files were changed this run; nothing to review',
      };
    }

    const filesBlock = files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');

    const prompt = `You are an independent code reviewer. You were NOT involved in writing this code and have
not seen any design notes or implementation reasoning -- deliberately, so your review isn't
anchored to the author's own assumptions. Review it the way a human reviewer works from a diff,
not an explanation of it.

The original requirement (for context on intent only): ${ctx.scenario.requirementText}

Files changed this run:

${filesBlock}

Look for real issues: bugs, missing edge cases, security problems, inputs that aren't validated,
error handling gaps, anything that contradicts the stated requirement. Do not invent stylistic
nitpicks to seem thorough -- an empty findings list is a legitimate, correct outcome if the code
is actually fine.

Respond with ONLY a JSON object (no markdown fences):
{ "rationale": string, "reviewFindings": string[], "reviewPassed": boolean }

"reviewFindings" lists concrete issues (empty array if none). "reviewPassed" should be false only
for a genuine blocking problem (a real bug, a security issue, a requirement violation) -- minor
suggestions belong in "reviewFindings" without failing the review.`;

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('llm agent: no text content in review response');
    }
    const parsed = JSON.parse(textBlock.text) as {
      rationale?: string;
      reviewFindings?: string[];
      reviewPassed?: boolean;
    };
    const reviewFindings = parsed.reviewFindings ?? [];
    const reviewPassed = parsed.reviewPassed ?? true;

    return {
      outputs: { reviewFindings, reviewPassed },
      rationale: parsed.rationale ?? '(no rationale returned by the model)',
      upstreamInvalidated: reviewFindingsToInvalidation(reviewPassed, reviewFindings),
    };
  }
}
