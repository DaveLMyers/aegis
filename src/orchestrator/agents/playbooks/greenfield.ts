import type { ProjectContext } from '../../state/projectContext.js';
import type { StageExecutionResult } from '../../types.js';
import type { StageExecutionOptions } from '../agent.js';
import {
  ANALYTICS_TS,
  CODEGEN_TS,
  DB_TS,
  INDEX_TS,
  OPENAPI_YAML,
  RATE_LIMIT_TS,
  ROUTES_TS,
  SERVER_TS,
  SHORTENER_TEST_TS,
} from './targetProjectTemplates.js';

const ASSUMPTIONS = [
  'Short codes are auto-generated (base62) unless the caller supplies a custom alias.',
  'Persistence is a single local SQLite database; no external services required for the prototype.',
  'Click analytics only need a count and a last-access timestamp for this iteration.',
];

async function requirements(_ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: requirement intake service timeout');
  return {
    outputs: {
      normalizedRequirement:
        'Implement a URL shortener service exposing: create short link, redirect by code (with click tracking), and per-code click analytics.',
      scope: ['POST /links', 'GET /:code', 'GET /:code/stats'],
      assumptions: ASSUMPTIONS,
    },
    assumptions: ASSUMPTIONS,
    rationale: io.fallback
      ? 'fallback: used the literal requirement text with no additional scoping detail'
      : 'requirement is well-defined; normalized directly into three concrete API endpoints',
  };
}

async function design(_ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: architecture review service unavailable');
  return {
    outputs: {
      designDoc:
        'Express app with three routes (create/redirect/stats) backed by SQLite (links, click_events). The redirect handler publishes a ClickEvent to an in-process event bus, consumed asynchronously into click_events -- decoupling the hot redirect path from analytics writes.',
      impactedModules: [
        'src/target-project/db.ts',
        'src/target-project/codeGen.ts',
        'src/target-project/analytics.ts',
        'src/target-project/rateLimit.ts',
        'src/target-project/routes.ts',
        'src/target-project/server.ts',
        'src/target-project/index.ts',
      ],
      technologies: ['typescript', 'node.js', 'express', 'better-sqlite3'],
    },
    rationale: 'greenfield: no existing modules to reconcile with, so the design follows directly from the normalized requirement',
  };
}

async function implementation(_ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  const files: Record<string, string> = {
    'src/target-project/db.ts': DB_TS,
    'src/target-project/codeGen.ts': CODEGEN_TS,
    'src/target-project/analytics.ts': ANALYTICS_TS,
    'src/target-project/rateLimit.ts': RATE_LIMIT_TS,
    'src/target-project/routes.ts': ROUTES_TS,
    'src/target-project/server.ts': SERVER_TS,
    'src/target-project/index.ts': INDEX_TS,
  };
  for (const [path, content] of Object.entries(files)) {
    io.tracker.writeFile(path, content);
  }
  // Simulated failure is checked AFTER writing, modeling a failure that occurs
  // once changes have already been partially applied -- this is what gives
  // rollback real files to revert rather than an empty change-set.
  if (io.simulateFailure) throw new Error('simulated failure: post-write verification step timed out');
  return {
    outputs: { filesChanged: Object.keys(files) },
    filesChanged: Object.keys(files),
    rationale: io.fallback
      ? 'fallback: reapplied the known-good playbook templates after the primary attempt failed (deterministic playbooks have no lower-fidelity variant yet -- see limitations)'
      : 'materialized the full modular target-project implementation from the known-good greenfield playbook templates',
  };
}

async function testAuthoring(_ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: test-authoring service timeout');
  io.tracker.writeFile('tests/target-project/shortener.test.ts', SHORTENER_TEST_TS);
  return {
    outputs: { testFilesChanged: ['tests/target-project/shortener.test.ts'] },
    filesChanged: ['tests/target-project/shortener.test.ts'],
    rationale: 'authored integration tests covering create, redirect, analytics tracking, validation, and 404 handling',
  };
}

async function documentation(ctx: ProjectContext, io: StageExecutionOptions, _projectRoot: string): Promise<StageExecutionResult> {
  if (io.simulateFailure) throw new Error('simulated failure: docs generation service timeout');
  const content = `# Scenario run: ${ctx.scenario.name}

**Type:** greenfield
**Requirement:** ${ctx.scenario.requirementText}

## What was built
- \`POST /links\` -- create a short link (optional custom alias / expiry)
- \`GET /:code\` -- redirect to the target URL, records a click event
- \`GET /:code/stats\` -- click count + last-access time for a code

## Persistence
SQLite (\`src/target-project/data/aegis.db\`), tables \`links\` and \`click_events\`.

## Notes
Click analytics are recorded asynchronously via an in-process event bus rather
than inline in the redirect handler, to keep the redirect path fast.
`;
  io.tracker.writeFile(`docs/generated/${ctx.scenario.name}.md`, content);
  io.tracker.writeFile('src/target-project/openapi.yaml', OPENAPI_YAML);
  const filesChanged = [`docs/generated/${ctx.scenario.name}.md`, 'src/target-project/openapi.yaml'];
  return {
    outputs: { docsChanged: filesChanged },
    filesChanged,
    rationale:
      'generated API documentation and a real OpenAPI 3.0 schema from the design doc and the implemented routes',
  };
}

export const greenfieldPlaybooks = { requirements, design, implementation, testAuthoring, documentation };
