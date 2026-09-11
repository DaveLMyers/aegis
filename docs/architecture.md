# AEGIS Architecture

AEGIS (Agentic Engineering Governance & Implementation System) is a governed SDLC
orchestration engine. It is demonstrated in this repo against a URL-shortener
target project, but the engine itself has no knowledge of URL shorteners —
that distinction matters and is explained in [Reusability](#reusability-engine-vs-agent-vs-playbook)
below.

## Two things this repo contains

1. **The orchestration engine** (`src/orchestrator/`) — the actual subject of this
   assignment. Coordinates a requirement through requirements → design →
   implementation/test-authoring (parallel) → testing → documentation →
   release-readiness, with gates, retries, rollback, policy guardrails, an
   audit trail, and metrics.
2. **The target project** (`src/target-project/`) — a URL-shortener REST
   service. It is the *fixture* the engine is demonstrated against, not the
   deliverable. It's intentionally kept lean.

## Control flow

```
requirements
     |
     v
   design  --(tech-standards gate)-->
     |
     +----------------+
     v                v
implementation   test-authoring     (parallel, share only the `design` dependency)
     |                |
     +--------+-------+
              v
           testing   <-- synchronization point: waits on BOTH parallel branches
              |
              v
        documentation
              |
              v
       release-readiness  <-- human approval gate
```

`implementation` and `test-authoring` both depend only on `design` and not on
each other, so the executor runs them concurrently; `testing` is the explicit
join point that waits on both. This is the "non-linear execution with
synchronization" requirement made concrete, not simulated.

A stage can also trigger a **re-plan**: if its result includes
`upstreamInvalidated: { stageId, reason }`, the executor invalidates that
stage and everything downstream of it in `ProjectContext`, then re-enters
execution from there — bounded by `maxReplans` per stage to prevent infinite
loops. See `src/orchestrator/graph/executor.ts` and `replanner.ts`.

## Core components

| Component | File | Responsibility |
|---|---|---|
| Stage graph | `graph/stageGraph.ts` | The 7 canonical stages, their dependencies, and each one's entry/exit gate |
| Executor | `graph/executor.ts` | Topological + parallel execution, retry/fallback/rollback/safe-stop orchestration, re-plan dispatch |
| ProjectContext | `state/projectContext.ts` | The cross-stage decision lineage -- every stage's inputs, outputs, rationale, and assumptions, appended not overwritten |
| Gates | `gates/gate.ts` | Composable entry/exit gate predicates (`requireOutputKeys`, `requireStagesPassed`, `requireTechStandardsCompliance`, ...) |
| Agent interface | `agents/agent.ts` | The seam between "the engine" and "how a stage's work actually gets done" |
| DeterministicAgent | `agents/deterministicAgent.ts` + `agents/playbooks/` | Default agent: dispatches to pre-authored, known-good playbooks per (scenario type, stage) |
| ClaudeAgent | `agents/claudeAgent.ts` | Optional agent: makes a real Anthropic API call per stage (`AGENT_MODE=llm`) |
| Policy engine | `policy/policyEngine.ts`, `policy/techStandards.ts` | Guardrails checked on every stage transition: change-control (writes confined to allowed dirs), release-control (no release without passing tests), secret-pattern scanning, approved-technology compliance |
| Resilience | `resilience/retry.ts`, `resilience/rollback.ts` | Bounded retry with backoff; filesystem change tracking + rollback |
| Observability | `observability/auditLog.ts`, `observability/metrics.ts` | Append-only JSONL audit trail; success rate / retry-rollback frequency / MTTR / latency computed from that trail |
| Replanner | `replanner.ts` | Bounds how many times a stage may trigger a re-plan |

## Human approval checkpoint

`release-readiness` is the one stage flagged `requiresApproval: true`. Its
playbook (`agents/playbooks/common.ts:releaseReadinessPlaybook`) either:
- auto-approves when the run was started with `--auto-approve` (used for the
  captured scenario evidence in `scenarios/runs/`, since those need to
  complete unattended), or
- prompts interactively at the CLI and records the human's actual decision.

Either way, the decision is written to the audit trail explicitly (never
silently implied), and a rejection fails the stage's exit gate exactly like
any other failed condition — triggering the same retry/fallback/rollback
chain, so a human "no" genuinely blocks the pipeline rather than being a
no-op checkbox.

## Resilience chain

For every stage: **retry** (bounded, with backoff) → **fallback** (one
degraded attempt) → **rollback** (revert every file that stage's
`ChangeTracker` wrote, restore `ProjectContext` to its pre-stage snapshot) →
**safe-stop** (halt the run cleanly, non-zero exit, evidence preserved).
Every transition is a distinct audit event. This is exercised, not just
implemented -- see `--inject-failure` in [setup.md](./setup.md).

## Policy guardrails, including the tech-standards gate

Beyond change-control and release-control, `design`'s exit gate checks every
proposed technology in its output against an approved-technology registry
(`policy/techStandards.ts`). This was added mid-build in response to a real
question: in an enterprise, an agentic engineering system shouldn't be free
to pick arbitrary technology per requirement -- it should check against
approved standards and only escalate to a human when a proposal deviates,
reusing the same approval mechanism as `release-readiness`. All three demo
scenarios use the one pre-approved stack, so this gate always passes cleanly
in the captured runs; the mechanism is real and unit-tested
(`tests/orchestrator/gate.test.ts`), just not visibly exercised by these
particular scenarios.

## Reusability: engine vs. agent vs. playbook

A natural question: is this built for URL shorteners specifically, or is it
a system that could take a different requirement entirely?

- **The engine is already fully generic.** Nothing in `graph/`, `gates/`,
  `resilience/`, `policy/`, `observability/`, or `replanner.ts` knows what a
  URL shortener is. Hand it a different `ScenarioDefinition` and it runs the
  identical governed pipeline.
- **`DeterministicAgent` is deliberately domain-specific.** Its playbooks are
  a fixed, hand-authored catalog keyed to `(scenario type, stage)` for this
  assignment. Feed it an unrecognized scenario type and it throws rather than
  improvising -- that's intentional: safe, reproducible, zero API cost, but
  bounded to known task shapes.
- **`ClaudeAgent` is the actual path to generality.** It has no playbooks; it
  sends the real requirement and stage context to Claude and uses the live
  response. In principle it can reason about an arbitrary new requirement,
  not just this one.
- **The honest gap:** `ClaudeAgent` does not yet parse generated code back out
  and write it via `ChangeTracker` the way the deterministic playbooks do. It
  demonstrates genuine per-stage LLM reasoning, but a production version
  would need that wiring to actually mutate an arbitrary target project, not
  only narrate what it would do. That's the concrete next step toward "give
  it a different problem and it builds it" -- not a rebuild, a completion of
  a seam that already exists.

## Known complexity/maintainability trade-offs

See "Maintainability & Complexity" in
[final-engineering-summary.md](./final-engineering-summary.md) for a direct,
unvarnished accounting of where this design trades simplicity for other
properties, and what a production version would need to change.
