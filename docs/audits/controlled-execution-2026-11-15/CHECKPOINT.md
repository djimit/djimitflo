# Controlled execution checkpoint — 2026-11-15

## Baseline and work context

- Repository: `djimit/djimitflo`
- Baseline: `origin/main` at `7758d153e415177de8e977721011c9675482934c`
- Work branch: `codex/functional-improvements-20261114`
- Candidate SHA at frozen denominator: `ecfc85d22e1a68307d63eaed9ce4bbcb87927e89`
- Worktree: `/private/tmp/djimitflo-functional-improvements-20261114`; clean before this audit package.
- Existing PR: #1272, draft; no merge or deployment authorized.
- Node/npm: v22.23.2 / 10.9.8.
- Preflight: `npm ci` passed (779 packages installed; 0 reported vulnerabilities); shared and agent-catalog builds passed at `35e260dd5dce1e6dd11d365f5a3a61d1d850432e`. Focused tests remain pending.

## Frozen denominators

- Critical chains: C1–C8 in `scope.json` (8 categories).
- Scenarios: S1–S16 in `scenarios.json` (16 scenarios).
- Historical hypotheses: H1–H10; resolution observations frozen in `scope.json`.
- Frozen denominator commit: `571a0ad3` (`docs: freeze controlled execution audit scope`). No tests for these denominators ran before that commit.
- Executable ceiling: E3 only with local normal route and mock/deterministic executor; E4 real runtime and E5 production are blocked by mandate.

## Completed steps

- Read repository loader, project commands, SOUL, USER and core-invariants. The supplied user mandate is the controlling session budget and disallows protected path changes, real runtime starts, production probes, paid calls, holdout access, new experiment registration, merge and deploy.
- Confirmed primary checkout has unrelated user changes and is not used for edits.
- Confirmed isolated worktree is clean at candidate SHA above.
- Confirmed remote `origin/main` currently resolves to the frozen baseline SHA above.
- Created initial audit package and froze C1–C8, S1–S16 and H1–H10 resolution observations in commit `571a0ad39f5d6ed6eb587302242949fb513152cc`.

## Commits

- `571a0ad39f5d6ed6eb587302242949fb513152cc`: froze baseline, critical-chain and scenario denominators before this session's preflight tests.
- Checkpoint metadata follow-up: records this freeze commit; does not change the frozen lists.
- `npm ci` completed; no package or lockfile changes are intended.
- Shared and agent-catalog TypeScript builds passed; focused nested-spawn tests are the next preflight step.

## Open scenarios and milestones

All S1–S16: `NOT_TESTED` at checkpoint creation. See `scenarios.json` for permitted evidence ceiling.

- M0: preflight in progress; install and requested builds passed, focused tests pending.
- M1: one vertical improvement permitted after baseline reproduction. Existing PR work is prior candidate evidence only; it does not replace this session's preflight or normal-entry verification.
- M2–M5: not started; default session budget does not authorize going beyond M0 + one M1 improvement.

## Budget

- Operator-provided wall-time/token budget: not provided.
- Applicable cap: M0 plus one vertical M1 improvement.
- Environment-reported token/cost usage: unavailable / not measured.
- Model calls, production access, runtime starts, holdout work and experiment registration: prohibited by default mandate.

## Open operator decisions

- None required for the permitted M0 and one M1 iteration.
- Any required protected-path, live-runtime, production, holdout, experiment, merge or deployment step remains unauthorized and must be proposed separately.

## Resume command

```bash
cd /private/tmp/djimitflo-functional-improvements-20261114 && git status --short --branch && npm ci
```

After dependency install, run the two frozen build/test commands from `verification.json`, update this checkpoint and verification artifacts, then investigate the frozen critical chains and select at most one M1 vertical fix.
