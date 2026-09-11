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

Every run also goes through an independent `review` stage between `testing`
and `documentation` -- deliberately isolated from `design`/`implementation`'s
own reasoning, reading only the actual file content produced. Its findings
(if any) are visible in `report.md` and folded into `release-readiness`'s
summary, so whoever approves the release sees them. See "Independent
review" in [architecture.md](./architecture.md).

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

`testing` and `release-readiness` always run through the same real
mechanisms (actual `vitest` execution, actual human-approval prompt)
regardless of agent mode -- only the generative stages (requirements,
design, implementation, test-authoring, documentation) go through the LLM.

See "Reusability" in [architecture.md](./architecture.md) for the full
design of this path.

## Giving it a genuinely new problem

Two flags combine to let AEGIS build something it's never seen, rather than
one of the three built-in scenarios:

```bash
# --requirement/--name build an ad-hoc scenario on the spot, no JSON file needed
# --target-repo points the entire write path at an external directory or a
# git URL (shallow-cloned into a temp dir) instead of this repo's own fixture
AGENT_MODE=llm npm run dev -- run \
  --requirement="Build a REST API for tracking book reading progress" \
  --name=reading-tracker \
  --target-repo=/path/to/some/other/repo \
  --auto-approve
```

This only produces something useful under `AGENT_MODE=llm` -- the
deterministic playbooks are specific to the built-in fixture's file layout
and will fail cleanly (not silently) against an unrecognized scenario type
or an unfamiliar codebase. `ClaudeAgent` is given a bounded file-tree
listing of the target directory so it has real structure to reason about
before proposing changes -- see Core Requirement 3 (Codebase Reasoning) in
[architecture.md](./architecture.md).

## Approving a release via a real GitHub PR instead of a CLI prompt

By default, `release-readiness` is a terminal `y/N` prompt (or auto-approved
with `--auto-approve`). `--release-via=github-pr` makes the approval action
a real PR merge instead:

```bash
AGENT_MODE=llm npm run dev -- run \
  --requirement="..." --name=my-feature \
  --target-repo=https://github.com/you/some-repo.git \
  --release-via=github-pr
```

The run commits everything it changed to a new branch, pushes it, opens a
PR with a description generated from the run's own decision lineage, then
polls (every 5s, `AEGIS_PR_POLL_TIMEOUT_MS` to override the 10-minute
default) for a human to merge or close it. A merge completes the run with
`approved: true`; closing without merging is treated as an explicit
rejection -- same as answering "n" at the CLI prompt -- and the branch/PR
are cleaned up automatically.

**Requires a real GitHub-hosted remote** (`gh pr create` only works against
one) -- this is designed for `--target-repo` pointed at an actual GitHub
URL, not for demoing against AEGIS's own repo, since branching/committing
there while you have your own work in progress risks tangling with it. This
was verified end-to-end against a real (isolated) clone of this repo: PRs
[#11](https://github.com/DaveLMyers/aegis/pull/11) (merged, confirmed the
poller detects it) and #12 (closed without merging, confirmed rejection +
cleanup) -- both since closed/cleaned up, not part of this repo's history
as ongoing state.

## Resetting to a clean slate

The target-project, its tests, and prior run evidence are all
orchestrator-generated and safe to delete:

```bash
npm run reset
```

(Cross-platform -- a small Node script, `scripts/reset.mjs`, rather than a
shell-specific `rm -rf` you have to remember and retype correctly.) Re-run
the three scenarios in order (above) to rebuild from scratch. If you re-run
an earlier scenario (e.g. `greenfield`) after a later one has already run
without resetting first, you'll hit the known ordering limitation -- stale
test files from the later scenario failing against the reverted code. Run
`npm run reset` first if that happens.
