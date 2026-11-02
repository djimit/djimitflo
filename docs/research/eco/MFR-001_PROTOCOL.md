# MFR-001 protocol: mutant-kill feedback retry (offline, Phase 1)

Status: **pre-registered**. This file is committed, and its sha256 recorded in `MFR-001_PROTOCOL.md.sha256` and in the
commit message, before the first item is scored. Source proposal: L3 report v2 (21-10), §9. Operator approval: 21-10, offline only.

## Hypothesis

H1: an exports-lane test that fails to kill seeded mutants of its target improves more when the maker is shown those
surviving mutants. Concretely, a retry prompt that lists the surviving **shown** mutants (file, line, mutation) makes the
retried test kill more **held-out** mutants than a same-budget retry that only says "strengthen the assertions of this test".

H0: the feedback retry kills no more held-out mutants than the control retry (difference < +0.15).

## Items

- **Population.** Every production maker lease from the last 30 days (export of 21-10) with
  `metadata.graded.lane = 'exports'`, `kind = 'mutant_kill'`, `total = 3` and `score < 1`. The export is read-only:
  `scripts/mfr-001/prod-export.cjs`, a READONLY better-sqlite3 handle. It returned 58 rows; the file sha256 is
  `355b30d4996b62c49e46d830709afd7f53ca3e050de1925cf813c688f2f949d9`.
- **Original test.** Each lease needs the test file the maker wrote. Two sources are allowed, in this order:
  1. The loop's own commit for the lease. This is the earliest commit whose message names `maker lease <id>`, fetched from
     the draft PR heads. It must change only the test file. Its first parent is the base commit.
     - Pin: sha256 of `git diff <parent> <commit> -- <test>`.
  2. The lease's `metadata.diff` (MAKER_DIFF_CAPTURE), when it holds exactly one new test file and is not truncated. The base
     is the newest `main` commit at or before the lease (`git rev-list -1 --first-parent --before`).
     - Pin: the lease's `diff_sha256`, recomputed and equal.
  - 7 items have both sources. For all 7, the test text rebuilt from the commit equals the new-file text in `metadata.diff`.
- **Manifest.** `docs/research/eco/mfr-001/items.json` (built by `scripts/mfr-001/build-items.mjs`) holds the following.
  - **42 items:** 39 from a maker commit and 3 from `metadata.diff`.
  - **16 exclusions:** 13 have neither source and 3 have fewer than 6 fresh mutants.
  - It records each item's pin, base, test, target, target sha256, the original test text, and the mutant descriptors.
  - The order is blind and seeded, by sha256(`mfr-001/order/v1/<id>`).
- **Pre-treatment exclusions** are applied on the workstation before any maker run. They are identical for both arms, because each item contributes either both arms or neither.
  - `original_test_red_at_base`: the rebuilt original test is not green on the real target.
  - `no_shown_survivor`: the original test already kills all 3 shown mutants. The treatment cannot be delivered, and the feedback prompt would equal the control prompt.
  - `infra`: npm ci or the build failed. These count toward the abort rule.
- **Fidelity (diagnostic, not an exclusion).** The harness recomputes the original test's kills on the 3 production mutants and compares them with production `graded.killed`. The match rate is reported.

## Mutants

- **Generator.** The production generator: `targetMutants` from `packages/server/src/services/gym-failure-tasks.ts`,
  which uses gym-mutants' operators and PRNG. It is applied to the target at the base commit, with the run id as the seed
  base, exactly as `graded-fitness.ts recordMakerGraded` called it.
- **Production mutants (P).** The first 3, `targetMutants(original, runId, target, 3)`. These are the prefix of every larger k, which is asserted.
- **Fresh mutants.** k = 6 per target: the first 6 of `targetMutants(original, runId, target, 12)` after P whose content differs from every P.
- **Split.** A seeded Fisher-Yates shuffle (mulberry32, seed = first 32 bits of sha256(`mfr-001/split/v1/<id>`)) puts 3 mutants in **S** (shown) and 3 in **H** (held out).
- **Disjointness.** H is disjoint from S and from P, by key and by content. This is asserted at build time and again on the workstation, after every mutant has been rebuilt from its descriptor and its sha256 checked.
- **Descriptors.** A mutant changes exactly one line, so it is stored as `{key, line, before, after, sha256}`.

## Design

**Paired within-item crossover.** Every eligible item is retried under **both** arms, each from an identical pristine state:

- the original test is committed;
- the target is real;
- no oracle files are present;
- a fresh, empty atomic-agent state is used.

`sha256(item id)` parity (an even last hex digit means feedback) decides which arm runs **first**. This balances order and drift.

> **Deviation from the brief, decided before scoring.** The brief asked for arms randomised between items by `sha256(item id)` parity, with ≥ 30 items per arm.
>
> The population holds 42 rebuildable items, and parity splits them 17 / 25. A between-item design therefore cannot reach 30 per arm.
>
> The paired design gives every eligible item one observation per arm. It keeps parity as the randomiser of order, and it is more powerful. The operator's between-item parity analysis is still computed, as a secondary analysis on the same data: feedback values from feedback-parity items, control values from control-parity items.

| | FEEDBACK | CONTROL |
|---|---|---|
| prompt | the control text **plus** "These seeded mutants of `<target>` were NOT caught … Add assertions so that the test fails for each of them: (1) `<target>` line N: \``before`\` was changed to \``after`\`; …" listing every S mutant that survived the original test | "Retry of a test-writing task: the vitest test file `<test>` already exists and covers `<target>`, but it is too weak … Change only `<test>` … Strengthen the assertions of this test." (`lib.mjs buildPrompt`) |
| maker | atomic-agent 0.6.5 in `djimitflo-gym-runner:atomic-0.6.5`, local llama-router via the atomic shim on the workstation | same |
| budget | `--max-steps 40`, 900 s wall clock, one attempt | same |

- **Source of the original test.** Both arms see the original test as the existing file in the worktree, referenced by path.
- **Held-out mutants in the prompt.** They are never present.
- **Leak check.** The exact maker input is checked before it is sent, by `lib.mjs assertNoLeak`. A leak is any held-out key, any rendered held-out description, or any held-out mutated line outside the shown descriptions. A hit throws `MFR_LEAK`, and the runner exits with code 3.
- **Held-out mutants on disk.** The maker's container mounts only the worktree. During a maker run, the worktree holds no oracle file, and this is asserted (`assertPristine`). The item JSON with the descriptors stays outside the worktree.

## Endpoint and outcome classes

Each retry is classified by `lib.mjs classify`, in this precedence order:

| class | meaning | held score |
|---|---|---|
| `infra` | harness or runner failure | excluded; the item's pair is dropped, and the run counts for the abort rule |
| `timeout` | the maker timed out with no change | 0 |
| `no_change` | the maker exited with no change | 0 |
| `out_of_scope` | a file other than the test changed | 0 |
| `baseline_red` | the retried test is red, or hung, on the real target | 0 |
| `ok` | test-only change, green on the real target | killed H / 3 |

- **Scoring.** The target is always restored to the real file before scoring. Each variant is one `npx vitest run <test>` from `packages/server`, with a 180 s cap. A red or hung run on a mutant counts as a kill, as in graded-fitness.
- **Primary endpoint.** Δ = mean over scored pairs of (held score FEEDBACK − held score CONTROL). It is intention-to-treat: every class except `infra` is in.
- **Secondary measures:**
  - per-arm mean held score;
  - per-arm class counts;
  - shown-mutant kill share (manipulation check);
  - the original test's held-out kill share;
  - prod-fidelity match rate;
  - the parity between-item analysis.
- **Baseline-red rate per arm** = `baseline_red` runs / scored pairs.

## Analysis and decision rule

- **Permutation test.** A one-sided sign-flip test on the paired differences, with 10 000 permutations, seed 20261021, and p = (1 + #{perm ≥ obs}) / (N + 1).
- **Bootstrap CI.** A percentile 95 % CI over items, with 10 000 resamples and seed 20261022.
- **Implementation.** Both are in `lib.mjs pairedStats`. The secondary analysis uses `unpairedStats`: a label permutation and a stratified bootstrap.

| Verdict | Condition (`lib.mjs decide`) |
|---|---|
| **SUPPORTED** | Δ ≥ +0.15 **and** the CI lower bound is > 0 **and** FEEDBACK baseline-red ≤ CONTROL baseline-red + 0.05 |
| **FALSIFIED** | the CI upper bound is < +0.15. This needs a `NEGATIVE_EVIDENCE.yaml` entry in the same PR. |
| **INCONCLUSIVE** | anything else |

- **Acceptance.** Acceptance needs ≥ 30 scored pairs, which is ≥ 30 per arm. Fewer pairs are reported as an acceptance failure, never as SUPPORTED.
- **Pre-registered extension if INCONCLUSIVE.** There is exactly one, and it does not run in this PR.
  - It adds every new exports-lane graded < 1 lease with a rebuildable test, until the item count reaches 80, or for 30 days, whichever comes first.
  - The rules are the same. The analysis is rerun once on all items.
  - The 21-10 population (58 rows, 64 graded in total, 3 test-gap graded) cannot reach 80 today.

## Procedure

1. Commit this protocol and its sha256 before the first scored item. A smoke run on a non-item (`gym-mutants.ts` at `main`, not a production lease) is allowed before that commit, and is not scored.
2. Take a zero-prod-write fingerprint (`orchestrate.mjs --fingerprint`). It records the count and sha256 of the `worker_leases` rows of every manifest lease, the `skill_outcomes` rows whose `task_id` is a manifest lease or run, or whose refs name a manifest lease, and the `judgments` rows whose `subject_id` is one of those. Table totals are recorded for context. The same fingerprint is taken after the run, and the touched-row fingerprints must be equal.
3. `orchestrate.mjs` runs on the operator Mac. The VPS never calls the workstation. For each item, in manifest order and one at a time, it does the following.
   - It runs the read-only prod check `prod-queue.cjs` and pauses for 300 s while any `remote_maker_jobs` row is `queued` or `claimed`.
   - It copies the item to the workstation.
   - It runs `nice -n 10 node run-item.mjs`. Runner containers run niced (`nice -n 10`) with `--cpus 8`, a separate npm cache volume (`mfr-001-npm`) and the label `djimitflo-gym-host=mfr-001`. The gym worker's orphan sweep (label `…=workstation`) and this harness never touch each other's containers.
   - It copies the result back.
4. On the workstation, `run-item.mjs` uses its own clone (`~/mfr-001/repo`) and a throwaway worktree at the base. The gym worker's repo, the systemd units (gym worker, kb-sync, host agent, llama-router, atomic shim) and `djimitflo-live` are never touched.
   1. It writes and commits the original test, then runs `npm ci`, the shared build and the agent-catalog build.
   2. It runs the original test on the real target and on P ∪ S ∪ H. This gives fidelity, the S survivors and the original H kill.
   3. It applies the pre-treatment exclusions.
   4. It runs the two arms in parity order.
   5. It scores each arm: base, then H, then S.
5. `score.mjs` aggregates the results into `docs/research/eco/mfr-001/results.json`. That file holds the raw per-item results (prompts and the retried test diffs, no secrets) and the summary.

## Stop rules

- Abort if > 20 % of the first 10 items fail on infrastructure, meaning 3 or more. Fix the harness, record the restart here as an amendment, and start again.
- Abort immediately on any held-out leak (runner exit code 3).
- Pause while the production remote maker queue is non-empty. This is checked before each item.
- Phase 1 holds no production state. Rollback means deleting `~/mfr-001` on the workstation.

## Guardrails

- 0 cloud tokens. The maker is the local llama-router only.
- 0 production writes. Prod is reached only through SELECT probes on a readonly handle.
- No experiment code runs in `djimitflo-live`.
- No command goes from the VPS to the workstation.
- No change to production code or flags. Phase 2 (`MFR_001_MODE`) is not part of this protocol.

## Pinned files (sha256 at registration)

Code is pinned as registered. A harness fix needed later is recorded here as a dated amendment, with its reason, before
the next item runs. `lib.mjs`, which holds the endpoint, the statistics and the decision rule, is never amended after the
first scored item.

| file | sha256 |
|---|---|
| `scripts/mfr-001/lib.mjs` | `16334c1b1521fc210f971cf8624e863578a2cd4adf98f919dab698d63be70fcd` |
| `scripts/mfr-001/build-items.mjs` | `45048ff0e97ac6d612d304333bccae247b3ec3ae5223ea4ee409e2cf6a73079a` |
| `scripts/mfr-001/run-item.mjs` | `e8dc80754832fba68464063c2a3b5f90b1e3dacdc93c458b0910493e121b0bc4` |
| `scripts/mfr-001/orchestrate.mjs` | `8f7c2388496ccefded953c136ad227b3092d0a4f9fac793183988468e3536675` |
| `scripts/mfr-001/score.mjs` | `a92f0cfedc1ee0281048503f8e835ec744d65fdf1f931a2857784b789057e74c` |
| `scripts/mfr-001/prod-export.cjs` | `8d3709dae70da9301e39e0bb949b97492d358436d5c811a00f43e7560f81a6f9` |
| `scripts/mfr-001/prod-queue.cjs` | `9dc425310b226d545f4134ad97bbd1131cdaff12f418f989cf816cfbc48a2961` |
| `scripts/mfr-001/prod-fingerprint.cjs` | `3c0238fa785d02d83e547a252cd89e52d54edeb3c02dc429622564e4ce6986e1` |
| `packages/server/src/__tests__/mfr-001-harness.test.ts` | `f61fa537be6532ae500fa60ba16c54aa3f9faa40bb1a2d274a107b1cc8172144` |
| `docs/research/eco/mfr-001/items.json` | `66d9893850b659785e0e0bd3773a21dc93ac9f7f93d87c2ed905f256db75e796` |

Base of the registration: `origin/main` 816f17e2.

The smoke run on the non-item (21-10, 21:12–21:37 UTC) finished end to end:
- `npm ci` and build, then original scoring;
- feedback arm `ok`, with held 2/3 and shown 3/3;
- control arm `timeout` at 900 s with no change;
- 24.5 min wall clock.

The smoke's only harness change was found in a first attempt: the workspace builds were added after `npm ci`, because
vitest could not resolve `@djimitflo/shared`. That change is already in the pinned `run-item.mjs`.
