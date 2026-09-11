# Setup & Usage

## Requirements

- Node.js 20+
- npm

## Install

```bash
npm install
```

## Run a scenario through the orchestrator

Scenarios must be run in this order the first time, since brownfield and
ambiguous both build on top of what greenfield materializes:

```bash
npm run dev -- run greenfield --auto-approve
npm run dev -- run brownfield --auto-approve
npm run dev -- run ambiguous --auto-approve
```

Each run prints a status line and writes its full evidence to
`scenarios/runs/<name>/<run-id>/`:
- `context.json` -- the complete decision lineage (every stage's inputs, outputs, rationale, assumptions)
- `audit.log.jsonl` -- append-only event log (every gate check, retry, rollback, approval)
- `metrics.json` -- computed reliability metrics for that run
- `report.md` -- a human-readable summary of both

Drop `--auto-approve` to be prompted interactively at the `release-readiness`
human-approval gate instead.

## Run the target-project API directly

```bash
npm run start:api
```

```bash
curl -X POST localhost:3000/links -H "Content-Type: application/json" \
  -d '{"targetUrl":"https://example.com"}'
# => {"code":"abc1234","targetUrl":"https://example.com",...}

curl -i localhost:3000/abc1234           # 302 redirect + records a click
curl localhost:3000/abc1234/stats        # click count, last-click time (+ referrer breakdown if premium tier)
```

## Run the tests

```bash
npm test
```

Runs both the orchestrator's own unit/integration tests
(`tests/orchestrator/`) and the target-project's API tests
(`tests/target-project/`).

## Demonstrating the resilience paths

The CLI supports deliberately injecting a failure into any stage, at one of
two severities:

```bash
# transient: fails only the first attempt -- retry recovers it
npm run dev -- run greenfield --auto-approve --inject-failure=testing --inject-failure-severity=transient

# hard: fails every attempt including the fallback -- forces rollback + safe-stop
npm run dev -- run greenfield --auto-approve --inject-failure=implementation --inject-failure-severity=hard
```

After a hard-failure run, diff `src/target-project/` against git to confirm
nothing was left half-applied -- rollback restores every file the failing
stage's `ChangeTracker` had written.

## Optional: real LLM-backed agent

By default, every stage is executed by `DeterministicAgent` (offline,
reproducible, no API key needed). To run a stage through a real call to the
Anthropic API instead:

```bash
cp .env.example .env
# set ANTHROPIC_API_KEY=sk-ant-... in .env
AGENT_MODE=llm npm run dev -- run greenfield --auto-approve
```

See "Reusability" in [architecture.md](./architecture.md) for what this path
does and does not do today.

## Resetting to a clean slate

The target-project, its tests, and prior run evidence are all
orchestrator-generated and safe to delete:

```bash
rm -rf src/target-project tests/target-project scenarios/runs/*
```

Re-run the three scenarios in order (above) to rebuild from scratch.
