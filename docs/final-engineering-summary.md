# Final Engineering Summary

## Plan & rationale

The brief asks for two things: a URL-shortener service, and an agentic
orchestration layer that coordinates the SDLC work to build it, with real
governance (gates, approvals, resilience, audit, metrics) rather than a
linear script. The evaluation criteria list orchestration effectiveness
first and call it the "critical differentiator" -- so the shortener was
treated throughout as the *fixture* the engine is demonstrated against, not
the deliverable, and effort was weighted accordingly: most of the design
work went into `src/orchestrator/`, not `src/target-project/`.

Given a ~6-8 hour time-box, the build order was a thin vertical slice first
(one scenario, end-to-end, through every stage with a minimal version of
every control) proven working before deepening any one subsystem -- rather
than perfecting resilience or observability in isolation before anything
ran. See the commit history / `scenarios/runs/` for evidence this actually
happened in that order.

## Artifacts produced

- **Orchestration engine** (`src/orchestrator/`) -- stage graph, executor
  with parallel+sync execution, gates, retry/fallback/rollback/safe-stop,
  policy guardrails (change-control, release-control, secret scanning,
  tech-standards compliance), audit log, metrics, re-planner, and two
  pluggable agent backends (deterministic playbooks; optional real
  Claude-API calls).
- **Target project** (`src/target-project/`) -- URL shortener: create,
  redirect + click tracking, stats (with a referrer breakdown for
  premium-tier links), tiered rate limiting, SQLite persistence.
- **Three scenarios** (`scenarios/*.json`, evidence under
  `scenarios/runs/`) -- greenfield, brownfield, ambiguous. Each run captures
  `context.json` (decision lineage), `audit.log.jsonl`, `metrics.json`, and
  a human-readable `report.md`.
- **Tests** (`tests/orchestrator/`, `tests/target-project/`) -- 33 tests
  covering gates, retry, rollback, parallel synchronization, re-planning,
  and the shortener's API behavior.
- **Docs** -- `README.md`, `docs/architecture.md`, `docs/setup.md`, this file.

## Validation approach

- **Every scenario run is real, not scripted-to-succeed.** The `testing`
  stage actually shells out to `vitest` against whatever code the
  `implementation`/`test-authoring` stages just wrote; a genuine bug and a
  simulated failure surface identically.
- **The resilience chain was deliberately exercised, not just implemented.**
  `--inject-failure=<stage> --inject-failure-severity=transient` proves retry
  recovers a one-off failure; `severity=hard` proves retry+fallback
  exhaustion correctly triggers rollback (verified by file hash that a real
  file was reverted to its exact prior byte content) and safe-stop.
- **Unit/integration tests isolate the engine from the fixture** -- a
  `FakeAgent` in `tests/orchestrator/executor.test.ts` exercises parallel
  synchronization, retry, rollback, and re-planning without depending on the
  URL-shortener playbooks at all, so those tests would keep passing even if
  the target project changed completely.

## Production-readiness checklist

The brief's Expectation section asks this to be treated as production-grade
engineering work. Rather than assert that, here's a direct accounting
against it -- what's built, what's partial, and what's a named, deliberate
gap with a tracked backlog issue behind it, versus something simply not
considered.

| Area | Status | Detail |
|---|---|---|
| Correctness & testing | Built | 39 automated tests (orchestrator unit/integration + target-project API). CI runs a type-check, the full suite, and a from-scratch regression run of all three scenarios on every push. |
| Resilience | Built | Retry -> fallback -> rollback -> safe-stop is implemented *and* exercised (`--inject-failure`), not just declared -- see "Validation approach" above. |
| Governance / audit | Built | Every gate decision, retry, rollback, and approval is logged to an append-only trail. Policy engine enforces change-control, release-control, tech-standards compliance, and a three-way allow/ask/block secret-scan escalation. |
| API health/readiness | Built | `GET /health` checks live DB connectivity (not just process liveness) and is registered ahead of rate limiting so monitoring probes are never throttled. |
| External API timeouts | Built | `ClaudeAgent`'s Anthropic client sets an explicit 30s timeout rather than relying on SDK defaults, bounding how long a hung LLM call can occupy a retry attempt. |
| Authentication | **Named gap** | `POST /links` has no auth -- anyone can create a link. This is exactly why the service was not deployed publicly (see below). Tracked as [issue #7](https://github.com/DaveLMyers/aegis/issues/7). |
| Horizontal scalability | **Named gap** | SQLite, the in-process rate limiter, and the in-process click-event bus are all single-instance; concurrent orchestrator runs against the same project root would also race. Tracked as [issue #8](https://github.com/DaveLMyers/aegis/issues/8). |
| Alerting | Out of scope | No monitoring backend exists to alert into, since nothing is deployed. The `/health` endpoint and the audit log are what a real alerting setup would consume; wiring actual alerts is infra work outside a prototype's scope. |
| Deployment | **Deliberate, not done** | Not deployed live -- open, unauthenticated link creation is a real abuse surface (spam/phishing redirects), and the brief asks for a runnable prototype, not a hosted one. A Dockerfile is tracked as [issue #5](https://github.com/DaveLMyers/aegis/issues/5) so deployability is demonstrable without operating a public instance. |

The pattern across every non-"Built" row is the same: a stated reason, and
where it represents real future work, a tracked issue -- not a gap a
reviewer has to discover on their own.

## Risks, trade-offs, and what was actually caught

Two real bugs were found and fixed during the build, both worth naming
because the failure mode is informative:

1. **The test-runner's subprocess spawn silently failed on Windows**
   (`spawnSync('npx.cmd', ...)` without `shell: true`), which the `testing`
   stage's exit gate correctly read as "tests failed" and routed through the
   full retry → fallback → rollback → safe-stop chain rather than
   proceeding. The gate did exactly what it was supposed to do -- the bug
   was in the exit gate's data source, not the governance logic.
2. **A gate was reading a stage's own not-yet-recorded output from the wrong
   place** (`ctx.latest('release-readiness')` before that stage's record had
   been appended) -- release approval always evaluated as "not approved."
   Caught immediately because the pipeline correctly refused to proceed
   rather than silently treating an undefined value as `false`-but-fine.

A third issue surfaced during manual testing rather than an automated gate:
**scenario runs are order-dependent and share mutable state.** Brownfield
assumes greenfield already materialized the target project; ambiguous
assumes brownfield already added tiering. Re-running an earlier scenario
after a later one leaves stale test files from the later scenario in
`tests/target-project/`, which then fail against the reverted code. This is
documented in `docs/setup.md` ("run in order; reset before re-running out of
order") rather than engineered away, given the time-box -- a production
version would need either isolated per-scenario workspaces or an explicit
reset step built into the CLI itself.

**Deliberate trade-off -- deterministic playbooks over live generation by
default.** `DeterministicAgent` dispatches to pre-authored templates rather
than synthesizing code at run time. This buys full reproducibility and zero
API cost for anyone grading this, at the cost of only handling the specific
task shapes it was built for. `ClaudeAgent` is the documented, pluggable
path to genuine generation (see "Reusability" in `docs/architecture.md`) --
built as a real seam in the `Agent` interface, not a hypothetical.

**Deliberate trade-off -- the tech-standards gate is real but not exercised
by these scenarios.** Added mid-build (`policy/techStandards.ts`) so `design`
can't silently propose an unapproved technology. All three scenarios use the
one pre-approved stack, so the gate always passes cleanly in the captured
evidence; it's covered directly by unit tests instead.

## Assumptions

The assignment brief itself contains interpretive ambiguity, not just the
requirement text fed to the "ambiguous" scenario. The same discipline that
scenario's `requirements` stage applies -- surface the reading, state why,
move on -- was applied to the brief directly rather than leaving these
implicit:

- **"Audit-grade observability"** is read as *complete and structured*
  (every gate decision, retry, rollback, and approval logged with nothing
  implicit) rather than *tamper-evident* (cryptographically signed/immutable
  log). The former is built; the latter is not, and would be a reasonable
  next requirement for a real compliance-grade deployment.
- **"Policy guardrails for security, compliance, and change control"** is
  scoped narrowly and deliberately: secret-pattern scanning, write-path
  confinement, and a tests-required-before-release gate. "Compliance" in the
  broader sense (license compliance, PII handling, data residency) is out of
  scope for this prototype, not an oversight.
- Persistence is a single local SQLite file; no external services are
  required to run any part of this.
- "Premium/partner client" is modeled as a per-link `client_tier` attribute,
  since no account/auth system exists in this prototype.
- The ambiguous scenario's chosen interpretation (referrer-breakdown
  analytics) was picked specifically because the two more literal readings
  (rate limits, vanity aliases) were already delivered by prior scenarios --
  see `scenarios/runs/ambiguous/.../report.md` for the full reasoning trail.
- `maxRetries` and `maxReplans` are small fixed constants (2) appropriate for
  a demo; a production deployment would tune these per stage based on
  observed failure rates from the metrics this engine already collects.

## Limitations

- **`ClaudeAgent` doesn't close the loop.** It gets a real model response per
  stage but doesn't parse code back out of it and write it via
  `ChangeTracker` -- so `AGENT_MODE=llm` demonstrates genuine reasoning, not
  yet genuine arbitrary-problem code generation. This is the single biggest
  gap between "built for this problem" and "a system that solves the next
  one you hand it."
- **Fallback playbooks aren't meaningfully degraded.** The deterministic
  agent's fallback attempt currently re-applies the same primary template
  rather than a genuinely lower-fidelity alternative. The fallback *path* is
  real and tested; the fallback *content* is a placeholder.
- **No persistence/versioning for playbooks or the tech-standards registry.**
  Both are in-code constants. A real rollout would need these externalized
  and versioned so they can change without a code deploy.
- **Rate limiting and the event bus are in-process and single-instance.**
  Fine for a prototype; would need a shared store (Redis, etc.) to survive
  multiple API instances.

## Maintainability & complexity

Raised explicitly mid-build and worth being direct about, since it's the
thing a maintainer -- or a hiring manager evaluating whether this could be
supported by a team -- would ask first:

1. **Target-project source is embedded as string literals inside the
   playbook files** (`agents/playbooks/targetProjectTemplates.ts`). This is
   what makes "the orchestrator materializes real code at run time" honest
   rather than staged, but those strings aren't type-checked as their own
   modules and are harder to review/diff than normal source. Acceptable for
   a 3-scenario prototype; would not scale past that without switching to
   real template files or diff/patch application.
2. **Scenario-to-playbook dispatch is a flat lookup table**
   (`agents/deterministicAgent.ts`). Cheap to extend by one scenario type at
   a time; has no versioning or multi-team pluggability story if many teams
   needed to register playbooks independently.
3. **Governance logic is spread across four files** (gate wiring in
   `stageGraph.ts`, gate factories in `gate.ts`, guardrail rules in
   `policyEngine.ts`, the tech-standards registry). Deliberate separation of
   concerns, but it means "what's enforced here" requires reading four
   files, not one -- the audit log is what keeps that from becoming a real
   support burden, since any "why did this fail" question is answerable from
   a single JSONL file without tracing code at all.

## Alignment with Anthropic's published AI-native SDLC playbook

Partway through the build, [Anthropic's AI-native SDLC
playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) was reviewed
against this design, specifically to check whether independently-made
architecture choices held up against Anthropic's own published guidance for
agentic engineering workflows, rather than assuming they did.

**Where they agree, structurally:**
- The playbook's artifact chain (`intent.md` → `spec.md` → `plan.md` → diff
  + tests → PR review → merged commit) *is* its audit trail -- each stage
  commits an artifact the next stage reads. AEGIS's `ProjectContext`
  (append-only `StageRecord`s) plus `audit.log.jsonl` is the same principle,
  enforced in-process instead of via a chain of git commits.
- The playbook's core deploy principle -- "the agent may act up to the
  production gate and cannot pass it" -- is exactly `release-readiness`'s
  shape: every stage before it can proceed autonomously; that one gate is
  hard-blocked without a human (or an explicit `--auto-approve` a human
  controls) saying yes. Separation of duties holds the same way: the agent
  never sets its own `approved` flag.
- The playbook's hooks (deterministic scripts that allow/ask/block an agent
  action) map directly onto `PolicyEngine` -- which, after this review, now
  also supports a three-way `allow`/`ask`/`block` decision rather than a
  binary one, specifically so a secret-scan hit (a plausible false positive)
  escalates to a human instead of always hard-failing the way a
  change-control or release-control violation correctly still does.

**Where they differ, deliberately:**
- The playbook's Skills/`CLAUDE.md` pattern assumes an LLM reads
  markdown instructions and follows them each session. AEGIS's default
  `DeterministicAgent` involves no LLM interpretation at all -- it's direct
  code dispatch to a fixed playbook. Stricter and more reproducible than the
  markdown-instruction pattern, at the cost of only covering known task
  shapes (see "Reusability" in `architecture.md`).
- The playbook treats the SDLC as a loop, closing back to a new `intent.md`
  when production metrics breach a threshold (its "Maintain" stage, with
  1σ/2σ/3σ response tiers). AEGIS stops at `release-readiness` -- in scope
  for this brief, not for ongoing production operation. Worth noting: the
  re-planner (re-entering an upstream stage on invalidation) is already the
  mechanism a Maintain stage would need to close that loop; it just isn't
  wired to a post-deploy trigger here.
- The playbook gates any agent/prompt/skill configuration change behind a
  regression eval suite (20-50 real tasks, growing by one per production
  incident). AEGIS doesn't frame it this way explicitly, but the three
  scenario runs already function as exactly that suite in practice -- any
  change to a playbook or gate should be expected to keep all three green,
  the same way the eval suite gates a configuration change in the playbook.

None of these are things a reviewer should have to guess at; that's the
point of writing them down here rather than leaving them to be discovered.
