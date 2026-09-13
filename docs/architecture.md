# AEGIS Architecture

AEGIS (Agentic Engineering Governance & Implementation System) is a governed SDLC
orchestration engine. It is demonstrated in this repo against a URL-shortener
target project, but the engine itself has no knowledge of URL shorteners —
that distinction matters and is explained in [Reusability](#reusability-engine-vs-agent-vs-playbook)
below.

## Two things this repo contains

1. **The orchestration engine** (`src/orchestrator/`) — the actual subject of this
   assignment. Coordinates a requirement through requirements → decomposition →
   design → implementation/test-authoring (parallel) → testing → review →
   documentation → release-readiness, with gates, retries, rollback, policy
   guardrails, an audit trail, and metrics.
2. **The target project** (`src/target-project/`) — a URL-shortener REST
   service. It is the *fixture* the engine is demonstrated against, not the
   deliverable. It's intentionally kept lean.

## Control flow

```
requirements
     |
     v
decomposition  <-- normalized requirement -> real task graph (Core Requirement 2)
     |          <-- HUMAN APPROVAL CHECKPOINT #1: sign off on the plan itself
     v
   design  --(tech-standards: policy 'ask' escalation)--> HUMAN APPROVAL CHECKPOINT #2 (ambiguous scenario)
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
           review    <-- independent of design/implementation's own reasoning
              |
              v
        documentation
              |
              v
       release-readiness  <-- HUMAN APPROVAL CHECKPOINT #3: the finished output
```

`implementation` and `test-authoring` both depend only on `design` and not on
each other, so the executor runs them concurrently; `testing` is the explicit
join point that waits on both. This is the "non-linear execution with
synchronization" requirement made concrete, not simulated.

`decomposition` is deliberately its own stage, not a field tucked inside
`requirements`' output. It answers a different question than the stage graph
you're looking at right now: this diagram is the fixed SDLC *lifecycle*,
identical for every scenario -- `decomposition`'s job is to break the
*requirement itself* into a real task graph (`Task { id, description,
dependsOn, acceptanceCriteria }`), which genuinely differs from one
requirement to the next. Its exit gate (`requireValidTaskGraph`,
`gates/gate.ts`) does real structural validation, not just key-presence: at
least one task, unique ids, every `dependsOn` reference resolves to a real
task in the same list, and no dependency cycle (verified via a topological
sort). See `agents/playbooks/decomposition.ts` -- each scenario type derives
a different task list from what `requirements` actually produced (read via
`ctx.latest('requirements')`), and the rendered task graph is visible
directly in `report.md`, not buried in `context.json`.

`review` depends only on `testing`, not on `design`/`implementation` directly
-- and, more importantly, the agent behind it never reads those stages'
rationale, only the actual file content produced. See
[Independent review](#independent-review-not-just-multi-role) below for why
that separation matters and what it does and doesn't buy.

A stage can also trigger a **re-plan**: if its result includes
`upstreamInvalidated: { stageId, reason }`, the executor removes that stage
and everything downstream of it from its own `completed` tracking set and
re-enters execution from there — bounded by `maxReplans` per stage to
prevent infinite loops. `ProjectContext` itself is untouched by this: its
records are append-only everywhere, including here, so the pre-replan
record for an invalidated stage is preserved alongside the post-replan one
rather than deleted (see the "Re-planning events" section `report.md`
renders when this fires). See `src/orchestrator/graph/executor.ts` and
`replanner.ts`.

## Core components

| Component | File | Responsibility |
|---|---|---|
| Stage graph | `graph/stageGraph.ts` | The 9 canonical stages, their dependencies, and each one's entry/exit gate |
| Executor | `graph/executor.ts` | Topological + parallel execution, retry/fallback/rollback/safe-stop orchestration, re-plan dispatch |
| ProjectContext | `state/projectContext.ts` | The cross-stage decision lineage -- every stage's outputs, rationale, and assumptions, appended not overwritten. `StageRecord.inputs` exists in the schema as a reserved field but is not yet populated at any write site (see Limitations) |
| Gates | `gates/gate.ts` | Composable entry/exit gate predicates (`requireOutputKeys`, `requireStagesPassed`, `requireOutputTrue`, `requireValidTaskGraph`, `allOf`, ...) |
| Task decomposition | `agents/playbooks/decomposition.ts` | The `decomposition` stage: converts the normalized requirement into a real, per-requirement task graph -- distinct from the fixed stage-graph lifecycle above |
| Agent interface | `agents/agent.ts` | The seam between "the engine" and "how a stage's work actually gets done" |
| DeterministicAgent | `agents/deterministicAgent.ts` + `agents/playbooks/` | Default agent: dispatches to pre-authored, known-good playbooks per (scenario type, stage) |
| ClaudeAgent | `agents/claudeAgent.ts` | Optional agent: makes a real Anthropic API call per stage (`AGENT_MODE=llm`) |
| Independent review | `agents/playbooks/review.ts` | The `review` stage: reads only the actual changed-file content, never the implementer's own rationale -- see below |
| Policy engine | `policy/policyEngine.ts`, `policy/techStandards.ts` | Guardrails checked on every stage transition: change-control (writes confined to allowed dirs), release-control (no release without passing tests), secret-pattern scanning, approved-technology compliance |
| Resilience | `resilience/retry.ts`, `resilience/rollback.ts` | Bounded retry with backoff; filesystem change tracking + rollback |
| Observability | `observability/auditLog.ts`, `observability/metrics.ts` | Append-only JSONL audit trail; success rate / retry-rollback frequency / MTTR / latency computed from that trail |
| Replanner | `replanner.ts` | Bounds how many times a stage may trigger a re-plan |

## Human approval checkpoints

Core Requirement 4 asks for "human approval **checkpoints**," plural, and
Core Requirement 7 for "oversight, **approvals**, and final quality
control" -- also plural. AEGIS has three, each gating a genuinely different
kind of decision, not the same checkpoint repeated:

| # | Stage | Gates | What a human is actually deciding |
|---|---|---|---|
| 1 | `decomposition` | `requiresApproval: true` (`graph/stageGraph.ts`), via `withDecompositionApproval` (`agents/playbooks/common.ts`) | The *plan* itself, before any implementation effort is spent executing it |
| 2 | `design` (currently only the `ambiguous` scenario exercises this) | `PolicyEngine`'s tech-standards check returning `ask` | Whether an off-standard technology proposal (Redis, considered for caching) is acceptable, given the design stage's own trade-off rationale |
| 3 | `release-readiness` | `requiresApproval: true`, via `releaseReadinessPlaybook` | The *finished, tested, reviewed* output, immediately before release |

All three share the same underlying mechanism (`requestApproval` in
`approval.ts`): auto-approve when the run was started with `--auto-approve`
(used for unattended scenario evidence), or prompt interactively at the CLI
and record the human's actual decision. Either way the decision is written
to the audit trail explicitly, never silently implied, and a rejection at
checkpoint #1 or #3 halts the run immediately (`ApprovalRejectedError` in
`executor.ts` -- a human "no" is a terminal decision, not something retried
or fallen back from) rather than being a no-op checkbox. Checkpoint #2's
mechanism is the same three-way `allow`/`ask`/`block` PolicyEngine decision
described below, applied on every stage transition, not just at design.

Both agent modes share checkpoints #1 and #3 for the same reason: an LLM
should not approve its own plan any more than it should self-report its own
tests passing (see [Independent review](#independent-review-not-just-multi-role)
for the same principle applied to code review).

## Resilience chain

For every stage: **retry** (bounded, with backoff) → **fallback** (one
degraded attempt) → **rollback** (revert every file that stage's
`ChangeTracker` wrote, restore `ProjectContext` to its pre-stage snapshot) →
**safe-stop** (halt the run cleanly, non-zero exit, evidence preserved).
Every transition is a distinct audit event. This is exercised, not just
implemented -- see `--inject-failure` in [setup.md](./setup.md).

## Independent review, not just multi-role

AEGIS's agents are single-agent, multi-role: one model, invoked separately
per stage with a distinct persona prompt each time (see "Reusability"
below). That's a deliberate, defensible pattern -- but it has one real
consequence worth naming: the same model that wrote `implementation` also
wrote `test-authoring`, so if it had a blind spot, both the code and the
tests checking that code can share it. Running the existing test suite
again doesn't fix that; it's still the same reasoning checking itself.

`review` exists specifically to break that chain. It depends only on
`testing` having passed, and -- this is the actual mechanism, not just a
naming choice -- its playbook (`agents/playbooks/review.ts`) never reads
`design`'s or `implementation`'s `rationale`. It reads the same file *content*
a human reviewer opening the diff would see, and nothing else. Under
`AGENT_MODE=llm` this is a genuine second, independent model call
(`ClaudeAgent.reviewStage()`), walled off from the first call's context on
purpose. Under the deterministic agent it's necessarily a lightweight
heuristic scan (empty files, leftover TODO/FIXME/XXX markers) -- the
playbooks are pre-vetted templates, so there's nothing genuinely novel for a
second pass to discover, but the mechanism is real and unit-tested either
way (`tests/orchestrator/review.test.ts`).

Findings are surfaced, not just gated: `release-readiness`'s summary
includes the review outcome and any findings (`agents/playbooks/common.ts`),
so whoever approves the release -- at the CLI or via a GitHub PR merge --
sees them before deciding, not just a pass/fail.

**A real finding sends the run back to `implementation`, not into the
resilience chain.** `review`'s exit gate is deliberately structural only
(did the review mechanism itself run) -- `reviewPassed: false` is not
treated as the *stage* failing, because it isn't a technical error; it's
information about the *code*. Instead, the playbook returns
`upstreamInvalidated` pointing at `implementation`
(`reviewFindingsToInvalidation` in `agents/playbooks/review.ts`, shared by
both agent modes so this decision lives in exactly one tested place), which
is a genuine re-plan through the same mechanism `--trigger-replan`
demonstrates -- `implementation` (and everything downstream of it) actually
re-runs. This is bounded by `maxReplans`, same as any other re-plan: if the
budget is exhausted and a finding still persists, the run proceeds anyway
with the finding intact in `review`'s record, surfaced to the human at
`release-readiness` rather than silently discarded or retried forever.
Under `AGENT_MODE=llm`, a re-run `implementation` attempt already sees
`review`'s prior rationale in its prompt's lineage context for free (prior
stage records are included generically, not specially wired for this) --
the deterministic agent's static templates have no way to act on feedback,
so this path is real and organically triggered for the first time by this
mechanism, but only meaningfully self-corrects under the LLM agent.

**What this is not:** true multi-agent debate, negotiation, or a
specialized model per role. It's one deliberate architectural choice --
isolate the review stage's context from the implementer's -- not a full
multi-agent rearchitecture. That's a scope decision, stated explicitly here
rather than left for a reviewer to wonder whether it was considered (see
"Considered and deliberately deferred" in
[final-engineering-summary.md](./final-engineering-summary.md) for the
fuller reasoning on why the rest of multi-agent stayed out of scope).

## Policy guardrails, including tech-standards compliance

Beyond change-control and release-control, `PolicyEngine` checks every
`design`-stage proposal's technologies against an approved-technology
registry (`policy/techStandards.ts`) -- as an `ask` escalation, not a hard
gate: an off-standard proposal routes to the same human-approval mechanism
`release-readiness` uses, with the design stage's own trade-off reasoning
attached, rather than just failing the stage repeatedly. This was added
mid-build in response to a real question: in an enterprise, an agentic
engineering system shouldn't be free to pick arbitrary technology per
requirement -- it should check against approved standards and only escalate
to a human when a proposal deviates. All three demo scenarios use the one
pre-approved stack, so this never fires in the captured runs; the mechanism
is real and unit-tested
(`tests/orchestrator/policy.test.ts`), just not visibly exercised by these
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
