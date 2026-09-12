import type { ProjectContext } from '../../state/projectContext.js';
import type { StageExecutionResult, Task } from '../../types.js';
import type { StageExecutionOptions } from '../agent.js';

/**
 * Core Requirement 2 (Task Decomposition), made concrete: converts the
 * normalized requirement from the `requirements` stage into a real task
 * graph -- distinct from `STAGE_GRAPH`, which is the fixed SDLC *lifecycle*
 * and identical for every scenario. This is the *work breakdown*, and it is
 * genuinely different per scenario because it's derived from what
 * `requirements` actually produced, not a copy-pasted constant.
 *
 * `requireValidTaskGraph` (gates/gate.ts) enforces real structure on the
 * result: unique ids, no dangling `dependsOn` references, no cycles.
 */

function greenfield(ctx: ProjectContext, io: StageExecutionOptions): StageExecutionResult {
  if (io.simulateFailure) throw new Error('simulated failure: decomposition service timeout');
  const scope = (ctx.latest('requirements')?.outputs.scope as string[] | undefined) ?? [];
  const tasks: Task[] = [
    { id: 'schema', description: 'Design the SQLite schema for links and click events', dependsOn: [], acceptanceCriteria: 'links and click_events tables exist with the columns every endpoint below needs' },
    { id: 'create', description: `Implement ${scope[0] ?? 'POST /links'}`, dependsOn: ['schema'], acceptanceCriteria: 'creating a link returns a unique short code, persisted' },
    { id: 'redirect', description: `Implement ${scope[1] ?? 'GET /:code'}, recording a click event`, dependsOn: ['schema', 'create'], acceptanceCriteria: 'visiting a valid code 302-redirects and increments its click count' },
    { id: 'stats', description: `Implement ${scope[2] ?? 'GET /:code/stats'}`, dependsOn: ['redirect'], acceptanceCriteria: 'stats reflect the actual recorded click count and last-click time' },
    { id: 'tests', description: 'Write integration tests covering create, redirect, and stats', dependsOn: ['create', 'redirect', 'stats'], acceptanceCriteria: 'tests fail against a broken implementation and pass against a correct one' },
  ];
  return {
    outputs: { tasks },
    rationale: `derived ${tasks.length} tasks directly from requirements' recorded scope (${scope.join(', ') || 'no scope recorded, used defaults'}); schema must exist before any endpoint, redirect depends on create existing, stats depends on redirect actually recording clicks, tests depend on all three being implemented`,
  };
}

function brownfield(ctx: ProjectContext, io: StageExecutionOptions): StageExecutionResult {
  if (io.simulateFailure) throw new Error('simulated failure: decomposition service timeout');
  const scope = (ctx.latest('requirements')?.outputs.scope as string[] | undefined) ?? [];
  const tasks: Task[] = [
    { id: 'inspect', description: 'Read the existing rate limiter and server wiring before proposing a change', dependsOn: [], acceptanceCriteria: 'the actual current limiter shape (flat vs. tiered) is confirmed from disk, not assumed' },
    { id: 'schema', description: `Add the schema change: ${scope[0] ?? 'client_tier on links'}`, dependsOn: ['inspect'], acceptanceCriteria: 'existing rows still load correctly after the column is added (default tier applies)' },
    { id: 'creation', description: `Extend link creation: ${scope[1] ?? 'POST /links accepts clientTier'}`, dependsOn: ['schema'], acceptanceCriteria: 'a link created without a tier defaults to standard; one created with a tier persists it' },
    { id: 'limiter', description: `Replace the flat limiter: ${scope[2] ?? 'tiered limiter on GET /:code'}`, dependsOn: ['creation'], acceptanceCriteria: 'a premium-tier link tolerates materially more requests/minute than a standard-tier one before being throttled' },
    { id: 'tests', description: 'Write regression tests proving standard-tier behavior is unchanged and premium-tier gets a higher budget', dependsOn: ['limiter'], acceptanceCriteria: 'the pre-existing greenfield test suite still passes alongside the new tier-specific tests' },
  ];
  return {
    outputs: { tasks },
    rationale: `derived ${tasks.length} tasks from requirements' recorded scope, ordered so the codebase is actually inspected before anything is proposed (Core Requirement 3), the schema change lands before anything depends on the new column, and tests cover both the new behavior and non-regression of the old`,
  };
}

function ambiguous(ctx: ProjectContext, io: StageExecutionOptions): StageExecutionResult {
  if (io.simulateFailure) throw new Error('simulated failure: decomposition service timeout');
  const chosen = (ctx.latest('requirements')?.outputs.normalizedRequirement as string | undefined) ?? '(interpretation not yet recorded)';
  const tasks: Task[] = [
    { id: 'confirm-groundwork', description: 'Confirm the tiering groundwork this interpretation builds on already exists on disk', dependsOn: [], acceptanceCriteria: 'routes.ts already has client_tier awareness before extending it further' },
    { id: 'schema', description: 'Extend the click-event query path to support grouping by referrer', dependsOn: ['confirm-groundwork'], acceptanceCriteria: 'referrer data recorded on click is queryable grouped by source' },
    { id: 'stats-extension', description: `Extend GET /:code/stats per the chosen interpretation: "${chosen}"`, dependsOn: ['schema'], acceptanceCriteria: 'premium-tier responses include a referrer breakdown; standard-tier responses are byte-for-byte unchanged' },
    { id: 'tests', description: 'Write tests proving the breakdown appears for premium tier only', dependsOn: ['stats-extension'], acceptanceCriteria: 'a standard-tier stats response has no referrerBreakdown field at all, not just an empty one' },
  ];
  return {
    outputs: { tasks },
    rationale: `derived ${tasks.length} tasks from the interpretation requirements chose ("${chosen}") rather than from the raw ambiguous requirement text directly -- decomposition operates on the normalized output, not the original ambiguity, which is requirements' job to resolve first`,
  };
}

export const decompositionPlaybooks = { greenfield, brownfield, ambiguous };
