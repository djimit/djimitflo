# Evolution gym (plan C2)

## Why

Selection needs many scored attempts. Production lanes give about one outcome a day, each behind a human approval
(2026-09-25: 7 verified in 7 days). Evolving maker species, prompts and memory rules at that rate takes months, and every
experiment would touch real proposals. The gym produces scored outcomes without touching `main` and without approvals.

## Task: replay a real fix from our own history

- Mined by `services/gym-task-miner.ts`: commits that changed exactly **one** live service file (≤ 80 changed lines, not
  auth/secrets/deploy/token/approval) together with one or two test files.
- The gym worktree is checked out at the commit, then the service file is restored to its **parent** version. The maker
  gets the commit's test file(s) and must make them pass by changing only that service file.
- **Oracle:** `npx vitest run <tests>` from `packages/server`. Red before the attempt (checked in the worktree; a task
  that is not red is discarded), green after = success.

Measured 2026-09-25 on this repository: 151 raw candidates since June, **140 tasks across 59 services** after filters
(last 120 days); 6/6 sampled tasks were red on the parent and green on the commit.

## Run (step b, next)

- A gym run is a loop run with `metadata.gym = { commit, source, tests }` and a synthetic finding "make these tests pass".
- Worktree at the commit (not `HEAD`), parent version of the source restored, `node_modules` as for other makers.
- Maker(s) per species (`LOOP_EVOLVE_SPECIES`, the bandit's candidates); deterministic check = the oracle command only.
- No checker, no security checker, no draft PR, no merge; the worktree is removed afterwards.
- Outcome → `skill_outcomes` with `domain = 'gym'` and the species; tokens and wall clock recorded.
- No human approval: nothing leaves the sandbox. Guarded by `EVOLUTION_GYM_ENABLED` (default off), a daily cap
  (`EVOLUTION_GYM_MAX_PER_DAY`), the token brake (`OPENCODE_MAX_RUN_TOKENS`) and the maker scope gate (only the source
  file may change).

## What it feeds

- **Bandit (C1):** species win rates from gym outcomes reach 20 per species in days, not months.
- **Memory rules (M5):** rules read during gym runs get fitness from the oracle.
- **Prompt/strategy variants (D2):** a paper-derived variant only enters production after it beats the incumbent here.

## Risks

- Overfitting to our own history: the gym measures "can repair code like ours"; production lanes stay the final judge.
- Memorisation: the commit message and the future of the file are not shown to the maker.
- Cost: capped per day and per run; gym runs never pre-empt production lanes.
