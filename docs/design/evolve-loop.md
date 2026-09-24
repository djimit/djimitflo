# Design: evolve-loop (plan E13) — several makers, one objective, fitness decides

Status: steps 1–3 implemented (2026-09-24), behind `LOOP_EVOLVE_ENABLED` (default off). Step 4 (mutation score) and 5 (funnel) open.

## Why

A loop run today has one maker. When it fails, a human (or the dream state) diagnoses and the proposal is retried with the
same runtime. That is one sample per attempt. Evolution needs variation and selection: several makers on the same
objective, an objective fitness function, and the winner carried forward (heredity via skills, plan E10).

## What already exists (reuse, no new orchestration)

- **Multiple makers per run.** Verification (`loop-verification-service.ts`) already counts only *non-superseded* makers
  (`metadata.superseded_by_maker_lease_id`, used for retries) and requires checkers ≥ makers for those.
- **Isolated worktrees per lease** (`worktree-manager.createWorktree`), working-tree diff incl. new files (#334),
  lockfile-noise restore (#338/#347), makers and reviewers install their own deps (#344/#347).
- **Deterministic checks per maker** (`LOOP_DAEMON_CHECK_SCRIPTS`), one human approval per run (`LOOP_REVIEWER_APPROVAL_INHERIT`).
- **Mutation testing** (Stryker, vitest runner): `npx stryker run --mutate <file>` scores how many mutants of the target
  a test suite kills — an objective fitness for test-writing objectives.

## Design

1. **Trigger.** A grounded proposal (target + runtime command) whose goal is marked `evolve: true` — first only test-gap
   proposals (the lane that works end to end), later dream-state fix proposals.
2. **Variation.** Prepare `N` maker leases (default 2, max 3) instead of one. Each gets a different *species*: runtime from
   `LOOP_EVOLVE_RUNTIMES` (e.g. `opencode,codex`) and/or a prompt variant. Each maker has its own worktree and budget.
3. **Fitness (all in code, per maker, after deterministic checks):**
   - hard: runtime exit 0, deterministic checks pass, diff within budget, only allowed paths changed;
   - score: mutation score on the grounding target (`stryker --mutate <target>`, only for test objectives), then smaller
     diff, then lower token use. Ties → the earliest finisher.
4. **Selection.** The fittest maker wins; every other maker gets `superseded_by_maker_lease_id = <winner>` and
   `metadata.evolve = { fitness, rank, reason }`. Loop event `evolve_selected` carries the full fitness table.
   From here the existing flow runs unchanged: checker + security checker for the winner only, verify, human approval
   (already given once), merge.
5. **Heredity.** The winner's species + prompt variant is recorded per niche (loop × target area × risk) for the skill
   archive and the later bandit (E10/E12). Losers and their failure causes go to the dream state (E11).

## Guardrails

- Only `services/` targets that have tests; never security, auth, deploy or policy paths (same limits as test-gap).
- One human approval per evolve run; budget cap per run = N × single-maker budget, N ≤ 3.
- Fitness is computed in code; no model decides the winner. A TypeSafe opinion may be recorded, never used to select.
- `LOOP_EVOLVE_ENABLED` default off; pilot on test-gap proposals only, then compare verified rate and cost per verified
  against single-maker runs before widening.

## Measure

- verified rate per evolve run vs single-maker runs; cost (tokens, minutes) per verified;
- mutation score of accepted tests; how often the winner differs by runtime (species fitness per niche).

## Implementation steps

1. ✅ `EvolveFitnessService` (pure: inputs → ranked list) + tests (#355).
2. ✅ Sibling makers: `retryLoopRun(..., { sibling: true })` adds a maker of another species (`LOOP_EVOLVE_SPECIES`,
   `runtime[@model]`, max 2 extra) for test-gap goals or `goal.metadata.evolve === true` (`evolve-selection.ts`).
3. ✅ Selection in the daemon after all makers ran their checks: rank, winner un-superseded, losers superseded and their
   reviewer leases cancelled, `evolve_selected` / `evolve_no_winner` event with the fitness table.
4. Mutation score step (optional per objective; skipped if Stryker is unavailable in the worktree).
5. Funnel: evolve runs, winner species, fitness distribution.
