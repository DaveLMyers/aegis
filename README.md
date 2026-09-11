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

## The brief this answers

Build a prototype that shows an agentic execution model actually running a
software engineering lifecycle end-to-end, with controlled autonomy rather
than an unsupervised agent or a simple linear task chain: an explicit
dependency graph with entry/exit gates, sequential and parallel paths with
synchronization, cross-stage decision lineage, human approval at high-impact
points, bounded retries/fallback/rollback/safe-stop, policy guardrails,
reliability metrics (success rate, retry/rollback frequency, MTTR, latency),
and dynamic re-planning when an assumption upstream turns out to be wrong --
demonstrated across a greenfield build, a brownfield change, and a
deliberately ambiguous requirement.

## Quick start

```bash
npm install
npm run dev -- run greenfield --auto-approve
npm run dev -- run brownfield --auto-approve
npm run dev -- run ambiguous --auto-approve
npm test
```

Each `run` writes its full evidence -- decision lineage, audit trail,
metrics, and a human-readable report -- to `scenarios/runs/<name>/`.

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
