import Anthropic from '@anthropic-ai/sdk';
import type { ProjectContext } from '../state/projectContext.js';
import type { StageExecutionResult, StageId } from '../types.js';
import type { Agent, StageExecutionOptions } from './agent.js';

const MODEL = 'claude-sonnet-5';

/**
 * Optional, pluggable alternative to DeterministicAgent: makes a real call to
 * the Anthropic API per stage and uses the live response as the stage's
 * output, for demonstrating genuine LLM-driven reasoning on request
 * (`AGENT_MODE=llm`).
 *
 * Known limitation (documented in docs/final-engineering-summary.md): this
 * path demonstrates real generative reasoning per stage, but does not parse
 * generated code back out and write it via the ChangeTracker the way the
 * deterministic playbooks do -- a production version would need that to
 * actually mutate the target-project, not just narrate what it would do.
 */
export class ClaudeAgent implements Agent {
  readonly mode = 'llm' as const;
  private readonly client: Anthropic;

  constructor() {
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
    if (io.simulateFailure) {
      throw new Error('simulated failure (llm agent, injected for resilience demonstration)');
    }

    const priorLineage = ctx.records.map((r) => `- ${r.stageId} (${r.status}): ${r.rationale}`).join('\n');

    const prompt = `You are the "${stageId}" stage of a governed SDLC orchestration engine building a URL-shortener target project.
Scenario: ${ctx.scenario.name} (${ctx.scenario.type})
Requirement: ${ctx.scenario.requirementText}

Prior stage lineage:
${priorLineage || '(none yet)'}

Respond with ONLY a JSON object (no markdown fences) of the shape:
{ "rationale": string, "assumptions": string[], "outputs": object }

"outputs" must satisfy this stage's contract:
- requirements: normalizedRequirement (string), assumptions (string[])
- design: designDoc (string), impactedModules (string[]), technologies (string[], restricted to: typescript, node.js, express, better-sqlite3)
- implementation: filesChanged (string[])
- test-authoring: testFilesChanged (string[])
- testing: testsPassed (boolean), testSummary (string)
- documentation: docsChanged (string[])
- release-readiness: approved (boolean)`;

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1024,
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
    };

    return {
      outputs: parsed.outputs ?? {},
      rationale: parsed.rationale ?? '(no rationale returned by the model)',
      assumptions: parsed.assumptions ?? [],
      filesChanged: [],
    };
  }
}
