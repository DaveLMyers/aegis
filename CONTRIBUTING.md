# Contributing

This describes the actual workflow this repo was built under, not an
aspirational one -- every PR merged into `master` so far went through this
exact process.

## Branching and commits

- No direct commits to `master`. Everything lands on a branch and goes
  through a pull request, even for solo work -- the point is traceability
  (an issue or a clear PR description explaining *why*, not just *what*),
  not process for its own sake.
- Branch naming: `feature/<short-description>` for new capability,
  `fix/<short-description>` for bug fixes, `docs/<short-description>` for
  documentation-only changes.
- Commit messages explain the *why*, not just the *what* -- the diff already
  shows what changed. If a change was prompted by a specific finding (a bug
  a test caught, a gap a review surfaced), say so in the commit body.

## Before opening a PR

```bash
npm install
npx tsc --noEmit    # must be clean
npm test            # must be fully green, no skipped tests
```

If the change touches the orchestrator or any playbook, reset and re-run all
three built-in scenarios from a clean slate to confirm the regression gate
still holds:

```bash
npm run reset
npm run dev -- run greenfield --auto-approve
npm run dev -- run brownfield --auto-approve
npm run dev -- run ambiguous --auto-approve
```

Commit the regenerated `scenarios/runs/` evidence alongside the code change
-- it's the reviewable proof the change didn't break anything, not just a
claim that it didn't.

## Opening a PR

Use the PR template (`.github/PULL_REQUEST_TEMPLATE.md`) -- a **Summary**
of what changed and why, and a **Test plan** as a checked list of what was
actually verified, not what should theoretically pass. CI (`.github/workflows/ci.yml`)
runs type-checking, the full test suite, and a from-scratch regression run
of all three scenarios on every PR targeting `master`.

**Note on stacked PRs:** if a PR is based on another still-open PR's branch
(rather than `master`), retarget its base to `master` as soon as the
dependency merges -- don't wait. Merging a PR with `--delete-branch` removes
that branch, and GitHub will auto-close any PR still based on it with no
way to reopen once the base ref is gone. (Learned this one the hard way --
see the collaboration history around PRs #13/#14 if you want the specifics.)

## Filing an issue

Backlog/future-work issues follow a consistent shape: **Context** (what
exists today and why it's insufficient), **Why it matters**, **Proposed
approach**. See the closed issues in this repo for the pattern, or use
`.github/ISSUE_TEMPLATE/`.

## Human approval is not optional

Every change to the target-project fixture goes through AEGIS's own
`release-readiness` gate before being considered "released" -- either an
interactive CLI approval or a real GitHub PR merge
(`--release-via=github-pr`). Changes to AEGIS's *own* source go through the
PR review/merge process described above. Both are the same principle
applied at two different layers: an agent can propose; only a human
approves.
