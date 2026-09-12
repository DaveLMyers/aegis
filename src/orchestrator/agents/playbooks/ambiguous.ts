import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectContext } from '../../state/projectContext.js';
import type { StageExecutionResult } from '../../types.js';
import type { StageExecutionOptions } from '../agent.js';
import { OPENAPI_YAML_TIERED_ANALYTICS, PREMIUM_ANALYTICS_TEST_TS, ROUTES_TIERED_ANALYTICS_TS } from './targetProjectTemplates.js';

const CANDIDATE_INTERPRETATIONS = [
  'Higher rate limits for premium clients -- already delivered by the brownfield tiered-rate-limit change.',
  'Custom vanity short codes for premium clients -- already generally supported via the alias field on link creation.',
  'A support/SLA commitment for premium clients -- not an API-level change; out of scope for a system that only builds software artifacts.',
  'Richer analytics for premium clients, e.g. a referrer breakdown instead of just a raw click count -- not yet covered by prior work.',
];

const CHOSEN_INTERPRETATION =
  "Richer analytics for premium clients: GET /:code/stats returns a referrer breakdown for premium-tier links (standard-tier responses are unchanged).";

const ASSUMPTIONS = [
  'The two most literal readings (rate limits, vanity aliases) are already covered by prior work, so treating this ask as "another one of those" would add no new value -- interpreted it as pointing at an uncovered dimension instead.',
  '"Improve the experience" is read as an API-visible capability a client can actually call, not an SLA/support commitment, since this system only produces software artifacts.',
  'The new capability is scoped to premium-tier links only, mirroring the differentiated-treatment pattern already established by the tiered rate limiter.',
];

/**
 * The point of this scenario: the requirement text is deliberately vague.
 * This stage has to do real interpretive work -- enumerate what it could
 * mean, rule options out with a stated reason, and only then normalize into
 * something the rest of the pipeline can decompose.
 */
async function requirements(ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: requirement intake service timeout');
  return {
    outputs: {
      normalizedRequirement: CHOSEN_INTERPRETATION,
      candidateInterpretations: CANDIDATE_INTERPRETATIONS,
      assumptions: ASSUMPTIONS,
    },
    assumptions: ASSUMPTIONS,
    rationale: `requirement text was deliberately vague ("${ctx.scenario.requirementText}"); surfaced ${CANDIDATE_INTERPRETATIONS.length} candidate interpretations, ruled two out as already delivered and one as out of scope, and normalized the remainder into a concrete, testable API change`,
  };
}

async function design(_ctx: ProjectContext, io: StageExecutionOptions, projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: architecture review service unavailable');
  const routesPath = resolve(projectRoot, 'src/target-project/routes.ts');
  if (!existsSync(routesPath)) {
    throw new Error('codebase-reasoning failed: target-project routes.ts not found -- run the greenfield scenario first');
  }
  const currentRoutes = readFileSync(routesPath, 'utf-8');
  if (!currentRoutes.includes('client_tier')) {
    throw new Error(
      'codebase-reasoning failed: routes.ts has no client_tier awareness yet -- run the brownfield scenario first so tiering exists to build on',
    );
  }
  return {
    outputs: {
      designDoc:
        "Extend GET /:code/stats: when a link's client_tier is premium, additionally query click_events grouped by referrer and include it in the response; standard-tier responses are byte-for-byte unchanged.",
      impactedModules: ['src/target-project/routes.ts'],
      technologies: ['typescript', 'node.js', 'express', 'better-sqlite3'],
    },
    rationale: 'confirmed the tiering groundwork from the brownfield change already exists on disk before designing on top of it',
  };
}

async function implementation(_ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: code generation service timeout');
  io.tracker.writeFile('src/target-project/routes.ts', ROUTES_TIERED_ANALYTICS_TS);
  return {
    outputs: { filesChanged: ['src/target-project/routes.ts'] },
    filesChanged: ['src/target-project/routes.ts'],
    rationale: io.fallback
      ? 'fallback: reapplied the known-good premium-analytics playbook template after the primary attempt failed'
      : 'extended the stats endpoint per the design doc; standard-tier code path is untouched',
  };
}

async function testAuthoring(_ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: test-authoring service timeout');
  io.tracker.writeFile('tests/target-project/premium-analytics.test.ts', PREMIUM_ANALYTICS_TEST_TS);
  return {
    outputs: { testFilesChanged: ['tests/target-project/premium-analytics.test.ts'] },
    filesChanged: ['tests/target-project/premium-analytics.test.ts'],
    rationale: 'added tests asserting premium responses include a referrer breakdown and standard responses do not',
  };
}

async function documentation(ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: docs generation service timeout');
  const content = `# Scenario run: ${ctx.scenario.name}

**Type:** ambiguous
**Requirement (as given):** "${ctx.scenario.requirementText}"

## How the ambiguity was resolved
Candidate interpretations considered:
${CANDIDATE_INTERPRETATIONS.map((c) => `- ${c}`).join('\n')}

**Chosen interpretation:** ${CHOSEN_INTERPRETATION}

**Assumptions recorded:**
${ASSUMPTIONS.map((a) => `- ${a}`).join('\n')}

## What changed
\`GET /:code/stats\` now includes a \`referrerBreakdown\` array for premium-tier links only.
`;
  io.tracker.writeFile(`docs/generated/${ctx.scenario.name}.md`, content);
  io.tracker.writeFile('src/target-project/openapi.yaml', OPENAPI_YAML_TIERED_ANALYTICS);
  const filesChanged = [`docs/generated/${ctx.scenario.name}.md`, 'src/target-project/openapi.yaml'];
  return {
    outputs: { docsChanged: filesChanged },
    filesChanged,
    rationale:
      'documented the full ambiguity-resolution trail alongside the resulting change, and updated the OpenAPI schema to show referrerBreakdown as present only for premium-tier responses',
  };
}

export const ambiguousPlaybooks = { requirements, design, implementation, testAuthoring, documentation };
