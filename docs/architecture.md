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

## Reusability: engine vs. agent vs. playbook vs. target

A natural question: is this built for URL shorteners specifically, or is it
a system that could take a different requirement entirely, against a
codebase it's never seen? As of this session, that question has a real
answer, not just an aspirational one.

- **The engine is fully generic.** Nothing in `graph/`, `gates/`,
  `resilience/`, `policy/`, `observability/`, or `replanner.ts` knows what a
  URL shortener is. Hand it a different `ScenarioDefinition` and it runs the
  identical governed pipeline.
- **`DeterministicAgent` is deliberately domain-specific.** Its playbooks are
  a fixed, hand-authored catalog keyed to `(scenario type, stage)` for the
  three built-in scenarios. Feed it an unrecognized scenario type (`adhoc`,
  see below) and it throws rather than improvising -- intentional: safe,
  reproducible, zero API cost, but bounded to known task shapes.
- **`ClaudeAgent` is the path to genuine generality, and it now closes the
  loop.** It has no playbooks; it sends the real requirement and stage
  context to Claude, and it parses `files: [{path, content}]` out of the
  response and writes each one via `ChangeTracker` -- the same rollback-aware
  write path the deterministic playbooks use. A prior version of this
  document named this as an open gap ("demonstrates reasoning, not yet
  generation"); it's closed.
- **The fixture the engine writes into is no longer hardcoded either.**
  `aegis run --requirement="<text>" --name=<slug> --target-repo=<path-or-url>`
  builds an ad-hoc `ScenarioDefinition` from a freeform requirement and points
  the entire write path (`ChangeTracker`, `PolicyEngine`'s allowed-write-dirs
  check) at an external directory instead of `src/target-project` -- a local
  path is used directly, a URL is shallow-cloned into a temp dir first, and
  both are treated identically. This is what actually proves "give it a
  different problem" rather than just asserting the engine is decoupled:
  AEGIS operating on a codebase it has never seen, under the exact same
  gates, is the real test.
- **Honest boundary that remains:** `--target-repo` only does something
  useful under `AGENT_MODE=llm`. `DeterministicAgent`'s playbooks write fixed
  paths like `src/target-project/db.ts`; pointed at an arbitrary external
  repo, that's not meaningful. The CLI warns rather than silently no-opping
  if you combine `--target-repo` with the deterministic agent.
- **A side effect worth naming:** the tech-standards gate (`design`'s exit
  gate checking proposed technologies against `policy/techStandards.ts`) was
  previously real but never exercised, since all three built-in scenarios use
  the one pre-approved stack. An ad-hoc requirement run through `ClaudeAgent`
  is free to propose a different stack -- the first time this gate can
  actually fire for real rather than only being unit-tested.

## Known complexity/maintainability trade-offs

See "Maintainability & Complexity" in
[final-engineering-summary.md](./final-engineering-summary.md) for a direct,
unvarnished accounting of where this design trades simplicity for other
properties, and what a production version would need to change.
