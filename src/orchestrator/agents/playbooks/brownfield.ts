import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectContext } from '../../state/projectContext.js';
import type { StageExecutionResult } from '../../types.js';
import type { StageExecutionOptions } from '../agent.js';
import {
  DB_TIERED_TS,
  OPENAPI_YAML_TIERED,
  RATE_LIMIT_TIERED_TS,
  ROUTES_TIERED_TS,
  SERVER_TIERED_TS,
  TIERED_RATE_LIMIT_TEST_TS,
} from './targetProjectTemplates.js';

/**
 * Brownfield assumes a prior greenfield run already materialized
 * src/target-project/*. Its design stage actually reads those files before
 * proposing a change -- the "codebase reasoning" requirement made concrete
 * rather than assumed.
 */
async function design(_ctx: ProjectContext, io: StageExecutionOptions, projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: architecture review service unavailable');

  const rateLimitPath = resolve(projectRoot, 'src/target-project/rateLimit.ts');
  const serverPath = resolve(projectRoot, 'src/target-project/server.ts');
  if (!existsSync(rateLimitPath) || !existsSync(serverPath)) {
    throw new Error(
      'codebase-reasoning failed: expected target-project modules were not found on disk -- run the greenfield scenario first so there is an existing codebase to modify',
    );
  }
  const currentRateLimit = readFileSync(rateLimitPath, 'utf-8');
  const isFlatLimiter = currentRateLimit.includes('MAX_REQUESTS') && !currentRateLimit.includes('LIMITS_BY_TIER');

  return {
    outputs: {
      designDoc: `Codebase reasoning: read rateLimit.ts and confirmed it is a ${
        isFlatLimiter ? 'flat, per-IP limiter (no tiering)' : 'limiter whose shape did not match the expected flat pattern -- proceeding cautiously'
      }, applied ahead of the links router in server.ts. Plan: add a client_tier column to links (schema change -- requires resetting the dev database), extend link creation to accept a clientTier, and replace the flat limiter with one that looks up each code's tier and applies a per-tier request budget.`,
      impactedModules: [
        'src/target-project/db.ts (schema)',
        'src/target-project/routes.ts (link creation)',
        'src/target-project/rateLimit.ts (limiter)',
        'src/target-project/server.ts (wiring)',
      ],
      technologies: ['typescript', 'node.js', 'express', 'better-sqlite3'],
    },
    rationale: 'inspected the existing target-project modules on disk before proposing a change, rather than assuming their shape',
  };
}

async function implementation(_ctx: ProjectContext, io: StageExecutionOptions, projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: code generation service timeout');

  // Schema changed (new client_tier column) -- reset the dev database so
  // CREATE TABLE IF NOT EXISTS picks up the new shape cleanly. This is
  // runtime/regenerable data, not source, so it is intentionally not tracked
  // for rollback the way source file edits are.
  const dbPath = resolve(projectRoot, 'src/target-project/data/aegis.db');
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (existsSync(p)) rmSync(p);
  }

  const files: Record<string, string> = {
    'src/target-project/db.ts': DB_TIERED_TS,
    'src/target-project/routes.ts': ROUTES_TIERED_TS,
    'src/target-project/rateLimit.ts': RATE_LIMIT_TIERED_TS,
    'src/target-project/server.ts': SERVER_TIERED_TS,
  };
  for (const [path, content] of Object.entries(files)) {
    io.tracker.writeFile(path, content);
  }
  return {
    outputs: { filesChanged: Object.keys(files) },
    filesChanged: Object.keys(files),
    rationale: io.fallback
      ? 'fallback: reapplied the known-good tiered-limiter playbook templates after the primary attempt failed'
      : 'patched the existing target-project modules per the design doc: schema, creation route, and limiter all updated together',
  };
}

async function testAuthoring(_ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: test-authoring service timeout');
  io.tracker.writeFile('tests/target-project/tiered-rate-limit.test.ts', TIERED_RATE_LIMIT_TEST_TS);
  return {
    outputs: { testFilesChanged: ['tests/target-project/tiered-rate-limit.test.ts'] },
    filesChanged: ['tests/target-project/tiered-rate-limit.test.ts'],
    rationale: 'added regression tests for the new clientTier field alongside the pre-existing shortener test suite',
  };
}

async function requirements(ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: requirement intake service timeout');
  const assumptions = [
    '"Premium partner clients" maps to a per-link client_tier attribute rather than a separate account/auth system, since none exists yet in this prototype.',
    '"Higher limits" is interpreted as a materially larger request budget (10x), not unlimited.',
  ];
  return {
    outputs: {
      normalizedRequirement:
        'Add tiered rate limiting: links tagged as premium-tier get a higher per-minute request budget than standard-tier links.',
      scope: ['schema: client_tier on links', 'POST /links accepts clientTier', 'tiered limiter on GET /:code'],
      assumptions,
    },
    assumptions,
    rationale: `requirement text was "${ctx.scenario.requirementText}" -- well-defined enough to decompose directly, with two explicit assumptions recorded above rather than left implicit`,
  };
}

async function documentation(ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: docs generation service timeout');
  const content = `# Scenario run: ${ctx.scenario.name}

**Type:** brownfield
**Requirement:** ${ctx.scenario.requirementText}

## Codebase reasoning
Read the existing \`rateLimit.ts\` and \`server.ts\` before proposing a change (see the design stage's
audit record for the exact finding).

## What changed
- \`links.client_tier\` column added ('standard' | 'premium', default 'standard')
- \`POST /links\` accepts an optional \`clientTier\`
- \`GET /:code\` is now rate-limited per tier: standard = 60 req/min, premium = 600 req/min

## Compatibility
Existing standard-tier behavior is unchanged; premium is strictly additive.
`;
  io.tracker.writeFile(`docs/generated/${ctx.scenario.name}.md`, content);
  io.tracker.writeFile('src/target-project/openapi.yaml', OPENAPI_YAML_TIERED);
  const filesChanged = [`docs/generated/${ctx.scenario.name}.md`, 'src/target-project/openapi.yaml'];
  return {
    outputs: { docsChanged: filesChanged },
    filesChanged,
    rationale:
      'documented the codebase-reasoning finding, the change itself, its backward-compatibility, and updated the OpenAPI schema to reflect clientTier on creation and stats',
  };
}

export const brownfieldPlaybooks = { requirements, design, implementation, testAuthoring, documentation };
