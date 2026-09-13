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
`scenarios/runs/<name>/<run-id>/` -- **local only, not committed** (see
"Nothing is pre-baked" below):
- `context.json` -- the complete decision lineage (every stage's outputs, rationale, assumptions; a reserved `inputs` field exists in the schema but isn't populated yet -- see Limitations in final-engineering-summary.md)
- `audit.log.jsonl` -- append-only event log (every gate check, retry, rollback, approval)
- `metrics.json` -- computed reliability metrics for that run
- `report.md` -- a human-readable summary of both
- `report.html` -- the same summary as a self-contained dashboard (no server, no build step -- just open it in a browser): reliability metrics as color-coded stat cards, the task graph as a real table, stage-by-stage lineage as cards. Open it directly, e.g. on Windows: `start scenarios/runs/greenfield/<run-id>/report.html`

Drop `--auto-approve` to be prompted interactively instead -- there are
three checkpoints, not one (see "Human approval checkpoints" in
[architecture.md](./architecture.md)): a plan-approval prompt right after
`decomposition`, a policy escalation during `design` on the `ambiguous`
scenario specifically (an off-standard technology it considers and
surfaces rather than adopting silently), and the `release-readiness` gate
at the very end. All three are answered the same way (`y`/`N`) and, without
`--auto-approve`, `ambiguous` is the scenario that will actually hit all
three in one run.

> **Windows/PowerShell note:** `npm run dev -- run greenfield --auto-approve`
> can silently drop everything after `--` when invoked from PowerShell
> specifically (npm's own echo will show the flag missing from the forwarded
> command) -- this is an npm/PowerShell argument-forwarding quirk, not a bug
> in AEGIS's own CLI parsing, and Bash/macOS/Linux are unaffected. If a run
> unexpectedly prompts for approval despite `--auto-approve`, bypass the npm
> wrapper and invoke the script directly instead:
> ```powershell
> npx tsx src/orchestrator/cli.ts run greenfield --auto-approve
> ```

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

The full request/response contract for all three endpoints is a real
OpenAPI 3.0 document at `src/target-project/openapi.yaml`, generated (and
updated) by the `documentation` stage of whichever scenario you last ran --
not a hand-written static file.

## Run the tests

```bash
npm test
```

Runs both the orchestrator's own unit/integration tests (`tests/orchestrator/`,
require nothing to have been run first -- they exercise the engine through a
`FakeAgent`, independent of the fixture) and the target-project's API tests
(`tests/target-project/`, which only exist after at least the greenfield
scenario has been run -- see "Nothing is pre-baked" below). On a fresh clone
before running any scenario, `npm test` runs the orchestrator suite only;
that's expected, not a failure.

## Demonstrating the resilience paths

The CLI supports deliberately injecting a failure into any stage, at one of
two severities:

```bash
# transient: fails only the first attempt -- retry recovers it
npm run dev -- run greenfield --auto-approve --inject-failure=testing --inject-failure-severity=transient

# hard: fails every attempt including the fallback -- forces rollback + safe-stop
npm run dev -- run greenfield --auto-approve --inject-failure=implementation --inject-failure-severity=hard
```

**Correction, found via a third-party review that actually ran this exact
command from a clean slate rather than trusting the claim below:** an
earlier version of this doc said `npm test` should still pass after a
hard-failure run. That's false for `--inject-failure=implementation`
specifically, and worth being precise about why. Rollback is scoped to the
*failing stage's own* `ChangeTracker` -- it correctly reverts everything
`implementation` itself wrote. But `test-authoring` is `implementation`'s
parallel sibling (both depend only on `design`), and it typically finishes
writing its test file *before* `implementation`'s failure is even detected.
That test file imports from the `target-project` files `implementation`'s
rollback then deletes -- so `npm test` fails with a module-not-found error,
not because rollback is broken, but because rollback has no visibility into
what a sibling in the same parallel batch already wrote. This is a real,
named gap (not yet fixed) in "Known Gaps" of
[final-engineering-summary.md](./final-engineering-summary.md). To actually
verify rollback after a hard-failure run: run `npm run reset` afterward,
which clears the inconsistent state left by any parallel-sibling writes,
before re-running scenarios.

**To see a real, non-null MTTR** (mean time to recovery), the two commands
above don't actually produce one on their own -- `transient` recovers
inside the default retry budget before any recorded failure, and `hard`
never recovers at all. `--max-retries` makes the failure exhaust the
*primary* attempts specifically, so the *fallback* attempt is what recovers
it -- a real fail-then-recover pair for the metric to measure:

```bash
npm run dev -- run greenfield --auto-approve --inject-failure=design --inject-failure-severity=transient --max-retries=1
```

Check `metrics.json` (or `report.html`) afterward -- `mttrMs` will be a real
number, not `null`.

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

## Nothing is pre-baked -- you run it

`src/target-project/`, `tests/target-project/`, and `scenarios/runs/` are
**gitignored, not committed**. The brief asks for a runnable prototype with
setup instructions, not sample results shipped alongside the code -- so
there is nothing to inspect until you actually run a scenario. This is a
deliberate choice, not an oversight: committing generated output previously
created two copies of the same code that could silently drift (the real
source of truth is always `src/orchestrator/agents/playbooks/`), and
committing timestamped run evidence was the direct cause of real merge
conflicts earlier in this project's history.

## Resetting to a clean slate

The target-project, its tests, and prior run evidence are all
orchestrator-generated, gitignored, and safe to delete at any time:

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
