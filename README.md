# AEGIS

**Agentic Engineering Governance & Implementation System** -- a governed SDLC
orchestration engine that coordinates a requirement through requirements
understanding, design, implementation, testing, documentation, and release
readiness under explicit gates, human-approval checkpoints, bounded
retry/fallback/rollback, policy guardrails, and audit-grade observability.

It's demonstrated in this repo against a small URL-shortener service, but
the shortener is the *fixture*, not the point -- see
[docs/architecture.md](docs/architecture.md#reusability-engine-vs-agent-vs-playbook)
for exactly what's domain-agnostic here and what's specific to this demo.

## What this demonstrates

Rather than one AI call that outputs code, a requirement here moves through
an actual governed pipeline. The stages form a real graph, not a hardcoded
script -- work can branch into concurrent paths and rejoin at a
synchronization point, and every stage's reasoning is carried forward
rather than discarded once the next one starts. A person, not the AI, has
to say yes before anything reaches release, and a "no" is respected
immediately rather than retried. When a step fails, the system doesn't just
error out: it retries, falls back to a simpler approach, and if that still
doesn't work, reverts every file it touched and stops cleanly instead of
leaving something half-built. Guardrails run automatically at each handoff
-- confining where code can be written, requiring tests to pass before
release, flagging anything that looks like a leaked credential -- every one
of those decisions is logged, and reliability numbers (success rate,
retry/rollback frequency, recovery time, total latency) are computed from
that log, not reported by hand. If something built earlier turns out to be
wrong once a later stage runs, the pipeline can jump back and redo the
affected work instead of continuing on a bad assumption. All of it is
exercised across three different kinds of requirement: building something
new, changing something that already exists, and one left deliberately
vague until the system itself has to work out what's actually being asked.

## Quick start

```bash
npm install
npm run dev -- run greenfield --auto-approve
npm run dev -- run brownfield --auto-approve
npm run dev -- run ambiguous --auto-approve
npm test
```

Each `run` writes its full evidence -- decision lineage, audit trail,
metrics, and a human-readable report -- to `scenarios/runs/<name>/` locally
(gitignored, not committed -- see "Nothing is pre-baked" in
[docs/setup.md](docs/setup.md)).

**Windows/PowerShell:** `npm run <script> -- <args>` can silently drop
flags in PowerShell specifically. If a run doesn't behave as flagged (e.g.
`--auto-approve` doesn't suppress the approval prompt), invoke the script
directly instead: `npx tsx src/orchestrator/cli.ts run greenfield --auto-approve`.
See [docs/setup.md](docs/setup.md) for details.

## Docs

- [docs/architecture.md](docs/architecture.md) -- components, control flow, key decisions
- [docs/setup.md](docs/setup.md) -- full usage, including demonstrating the resilience paths
- [docs/final-engineering-summary.md](docs/final-engineering-summary.md) -- plan, rationale, risks/trade-offs, assumptions, limitations

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch/PR/CI workflow this
repo is actually built under. Governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). Licensed under [MIT](LICENSE).
