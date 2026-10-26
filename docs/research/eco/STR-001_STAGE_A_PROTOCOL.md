# STR-001 Stage A protocol: does a "strengthen the assertions" retry kill more independent mutants? (offline re-scoring)

Status: **pre-registered**. This file is committed and pushed, and its sha256 recorded in
`STR-001_STAGE_A_PROTOCOL.md.sha256` and in the commit message, before the first unit is scored. Source proposal:
EVOLUTION-001 (draft PR #960, `docs/research/evolution-001/EVOLUTION-001-EXPERIMENTS.md`), STR-001. Operator
authorisation: 22-10, "Execute authorized STR-001 Stage A without GPU expenditure".

## Background and why this is confirmatory

MFR-001 (PR #959, NE-013) was FALSIFIED. A post-hoc observation from it: the CONTROL arm, a retry that only said
"strengthen the assertions of this test", raised the held-out mutant kill share from 0.150 (the original test) to 0.467.
That is +0.317, CI [0.217, 0.425], with 23 up, 0 down and 17 the same.

That observation is exploratory, for three reasons:
- it was not the registered endpoint;
- the held-out mutants came from the same gym generator and seed base as the production mutants;
- the retried tests are much larger. EVOLUTION-001 gives a median of +194 lines; this manifest counts a median of 202 added `+` lines over the 38 retried tests.

Stage A re-scores the **existing** outputs of MFR-001 against two mutant families that no maker prompt ever saw, under
the rules below. There are no new maker runs, no model calls and no GPU.

## Hypothesis

- **H1:** the strengthen-retried test kills a larger share of **independent** mutants of its target than the original test.
- **H0:** the paired difference (strengthen − original) in kill share is ≤ +0.05.

## Units

- **Population.** Every MFR-001 item that reached the arms, which is 40 of 42; the 2 `no_shown_survivor` items never ran an arm.
  - The source is the MFR-001 manifest, `exp/mfr-001:docs/research/eco/mfr-001/items.json`. Its sha256 is `66d98938…e796`, which equals the MFR pin.
  - The other source is the per-item raw MFR results, which are unredacted. Each file's sha256 is in `str-001/manifest.json` `built_from`.
- **Original test.** `items.json original_test`, as pinned by MFR-001.
- **Strengthen-retried test.** The MFR CONTROL arm's test file after its retry.
  - It is rebuilt by applying the stored `retried_test_diff` to the original test.
  - It must equal the stored `retried_test_sha256`. All 38 control runs that changed the test rebuild exactly.
  - The 2 control runs that timed out with no change have no retried test.
- **Manifest.** `docs/research/eco/str-001/manifest.json`, built by `scripts/str-001/build-manifest.mjs`.
  - It holds 40 units, in a blind seeded order by sha256(`str-001/order/v1/<id>`).
  - It holds both tests, every MFR mutant descriptor and the family (a) descriptors.
  - **Redaction.** Secret-shaped fixtures in the test text are replaced by neutral placeholders: 4 in one retried test (`f3b02803`), an AWS key shape and a Slack token shape. The runner uses an unredacted local copy and checks it against the recorded sha256.

## Mutant families: independent, and neither seen by any maker prompt

**(b) Stryker (primary).** This is the most independent family: a different generator, different operators, and every mutable site of the target.
- **Tool.** The repo-pinned `@stryker-mutator/core` 10.0.0 and `@stryker-mutator/vitest-runner` 10.0.0, both root devDependencies, run from each base's `npm ci` tree. The version is asserted per unit. No dependency is added.
- **Mutator set.** The repo's own configuration: `excludedMutations: ['StringLiteral', 'ObjectLiteral']`, as in `stryker.config.js` and `stryker.service.config.mjs`. The set is asserted against the base's `stryker.service.config.mjs`.
- **Other settings.** `coverageAnalysis: 'perTest'`, as in the repo. `mutate` is the target file only, and `inPlace` is used in the throwaway worktree.
- **Test environment.** The test runs under `packages/server/vitest.config.mts` with `include` restricted to the one test file. This is the environment MFR-001 scored in, `npx vitest run <test>` from `packages/server`. The runner writes this config to the worktree only; it is never committed.
- **Unit mutant set M_b.** The mutants of the original test's run whose status is valid: Killed, Timeout, Survived or NoCoverage. Excluded from it are:
  - CompileError, RuntimeError and Ignored. Ignored means the mutator set excluded it.
  - every mutant whose mutated file content, rebuilt from its location and replacement, equals the content of any MFR-001 mutant of the item (production, shown or held out). These are dropped and counted.
- **Identity.** The retried run must report the same mutant identities, `mutator@location=>sha256(replacement)`. A missing identity is a harness error.
- **Kill share.** (Killed + Timeout) / |M_b|, as in `scripts/mutation-gain.mjs score`.

**(a) Fresh gym mutants (secondary).**
- **Generator.** The production gym generator, gym-mutants.ts `mutate(target, 1, rng(seed))`, under a **new** seed family: seed = first 32 bits of sha256(`str-001/a/v1/<item id>/<j>`), j = 0..599.
  - MFR-001 used `targetMutants(…, runId, …)`. Its seeds are `seed·7919 + runId.charCodeAt(0)`, seed 1..50.
- **Selection.** No-ops and duplicates are skipped, and so is **every content equal to an MFR-001 mutant** of the item (all 9: production 3, shown 3, held out 3). The first 12 are kept.
- **Eligibility.** A unit with fewer than 3 is not in family (a). All 40 have at least 3: 31 have 12, and 9 have between 3 and 9.
- **Disjointness.** Asserted at build time and again on the workstation, after every mutant has been rebuilt from its descriptor and its sha256 checked. It holds by key and by content.
- **Scoring.** One `npx vitest run <test>` per mutant from `packages/server`, with a 180 s cap. Red or hung counts as killed, as in graded-fitness and MFR-001. Kill share = killed / n.

## Classes (strengthen arm), in precedence order

| class | meaning | value |
|---|---|---|
| `no_retry` | the MFR CONTROL retry left no changed test (timeout or no change) | 0 (ITT, the MFR-001 convention) |
| `baseline_red` | the retried test is red or hung on the real target in Stage A | 0 (ITT) |
| `ok` | the retried test is green on the real target | its kill share per family |

- **Original red at base.** If the original test is red or hung on the real target in Stage A, the unit is excluded from both families before treatment.
- **Stryker infra on the original test.** If the original test is green but its Stryker run fails, the unit is excluded from family (b) only.
- **Stryker infra on the retried test.** If an `ok` retried test's Stryker run fails, the pair is dropped from (b). This is counted and reported.

## Endpoints and analysis

- **Per family.** d_i = kill(strengthen)_i − kill(original)_i over the scored units, ITT as above.
- **Primary.** Family (b), Stryker. Family (a) is secondary.
- **CI.** A paired percentile bootstrap 95 % CI of mean d, with 10 000 resamples and seed 20261023 (+1 for family (a)).
- **Test.** An exact one-sided sign test (H1: P(d > 0) > ½), with ties dropped.
- **Multiplicity.** Holm across the 2 families on the sign-test p.
- **Implementation.** `scripts/str-001/lib.mjs` (`pairedSummary`, `signTest`, `holm`, `bootCI`, `summarize`).

| Verdict | Condition (`lib.mjs decide`, on family (b)) |
|---|---|
| **SUPPORTED** | Holm-adjusted p < 0.05 **and** CI lower bound > +0.05 |
| **FALSIFIED** | CI upper bound < +0.05. A `NEGATIVE_EVIDENCE.yaml` entry is required in the same PR. |
| **INCONCLUSIVE** | anything else |

- **Acceptance.** It needs ≥ 30 scored units in family (b). Fewer are reported as an acceptance failure, never as SUPPORTED.
- **Family (a).** It is reported with its Holm-adjusted p and CI. It does not change the verdict.

### Size control (registered, descriptive; it plays no part in the verdict)

The retried tests are much larger than the originals. These analyses separate "more assertions" from "better assertions".
Each is reported per family. "Added lines" are the `+` lines of the stored retry diff.

1. **Kill share per added line.**
   - the median over units of 100·d_i / added_i;
   - the aggregate Σ(d_i·|M_i|) / Σ added_i, which is extra mutants killed per 100 added lines.
2. **Small-retry subset.**
   - Membership: the units with a retried test whose added lines are ≤ the median added lines of those units.
   - Reported: Δ, the bootstrap CI and the sign test.
3. **Regression.**
   - The model: OLS of d_i on added_i / 100 over the ITT units.
   - Reported: intercept and slope, each with a pairs-bootstrap 95 % CI.
   - A descriptive companion regression on the number of added `expect(` calls.
4. **Reading rule, fixed now.**
   - **Not only size.** If the small-subset CI lower bound is > 0 in family (b), the gain is not explained by size alone.
   - **Size.** If the small-subset CI includes 0 and the slope CI excludes 0, the gain is attributed mainly to size ("more assertions").

### Sensitivity (registered, descriptive)

- **S1.** A `no_retry` unit keeps the original test (d = 0) instead of scoring 0.
- **S2.** Per protocol: `ok` units only.

### Not available in Stage A

- **The fresh-attempt comparison.** This is a same-budget fresh write-test attempt with no existing test. It needs new maker runs, which means GPU, and that is Stage B. Stage A cannot say whether "strengthen" beats simply asking again.
- **Generator independence.** Both tests in a pair came from the same maker family. Stage A compares a test with its own retry, not two generators.

## Procedure

1. **Before registration.**
   - The manifest was built (above).
   - A smoke run on a non-item took place on 22-10, in three attempts between 20:24 and 20:34 UTC: target `gym-mutants.ts` with its own test at `origin/main`, and a "retried" copy that added only a comment. It is not scored.
   - The first attempt found that the gym runner image has no `ps`, which Stryker's process-tree kill needs. The runner therefore uses `str-001-runner:1` = `djimitflo-gym-runner:atomic-0.6.5` + `procps`, built locally on the workstation. Nothing else differs. The third attempt added the CPU-time measurement (`times` after each container command).
   - Smoke numbers: 184 Stryker mutants, 147 valid. Attempt 2 gave original 0.612 against copy 0.619; attempt 3 gave original 0.619 against copy 0.626. In each attempt 1 of 147 mutants was discordant between the two identical tests (`MethodExpression`, Survived/Killed). That gives a test-retest noise floor of ≈ 0.007 per unit, far below the +0.05 margin. Family (a): 12 mutants, 0.75 against 0.75. A unit took 156 s wall time and 401 s CPU.
2. **Registration.** Commit and push this protocol, its sha256 and the pinned scripts before the first unit.
3. **Workstation CPU only.** The run uses `ssh djimit@100.81.133.48` from the operator Mac. The VPS never calls the workstation.
   - **Driver.** `scripts/str-001/run-all.mjs` runs under `setsid nohup nice -n 10`. It takes one unit at a time in manifest order, and each unit runs as `nice -n 10 node run-item.mjs`.
   - **Worktree.** Each unit gets its own clone (`~/str-001/repo`, from GitHub) and a throwaway worktree at the unit's base, with the original test committed.
   - **Install.** `npm ci` and the shared and agent-catalog builds run in a container labelled `djimitflo-gym-host=str-001`. Containers run niced, with `--cpus 8`, their own npm volume (`str-001-npm`) and Stryker concurrency 4.
   - **Scoring.** Score the original test: baseline, then the family (a) mutants, then Stryker. Then score the retried test (if any) in the same order. The target is verified and restored after every Stryker run.
   - **No model.** No model endpoint is configured or reachable from the run: there is no llama-router, no atomic-agent and no cloud model.
   - **Untouched.** The gym worker, its repo and containers, the systemd units (gym worker, kb-sync, host agent, llama-router, atomic shim) and `djimitflo-live` are never touched.
4. **Scoring.** `scripts/str-001/score.mjs` writes `docs/research/eco/str-001/results.json`, which holds the raw per-unit results, the summary and the verdict. Secret-shaped strings are redacted.

## Stop rules

- Abort if ≥ 3 of the first 10 units end as `infra`. Fix the harness, record the restart here as a dated amendment, and start again.
- `lib.mjs`, which holds the endpoint, the statistics and the decision rule, is never amended after the first scored unit.
- Rollback means deleting `~/str-001`, the `str-001-npm` volume and the `str-001-runner:1` image on the workstation.

## Guardrails

- 0 GPU, 0 model calls and 0 cloud tokens.
- 0 prod reads and 0 prod writes. Stage A needs no prod data, and none is read.
- No code runs in `djimitflo-live`.
- No command goes from the VPS to the workstation.
- No change to production code or flags.

## Pinned files (sha256 at registration)

| file | sha256 |
|---|---|
| `scripts/str-001/lib.mjs` | `b5e03c2222a169d9427e79b88b42c88ba9fd77f4230efab5a3ff520e1845adf0` |
| `scripts/str-001/build-manifest.mjs` | `3fedfaac85daae7922d265ca34aabb86300336b63d6ab4246d88f4488438e5c2` |
| `scripts/str-001/run-item.mjs` | `4092b809b50ec131f6ffc566ec823a8e7f5bde5a1e904f9e89cb95a7d7dc6740` |
| `scripts/str-001/run-all.mjs` | `d71b17b0da05b18050d94421335dcd0aad2231410243f442af90dcf2c78a1e0e` |
| `scripts/str-001/score.mjs` | `b0686d10aeff3da91722a401bb0ff1f2931ac5377de4001277cb381e5e179ce2` |
| `packages/server/src/__tests__/str-001-harness.test.ts` | `e04207d883c3d0232b267c849815a6d2b32a339b63c05d7e04ad6d065baf3388` |
| `docs/research/eco/str-001/manifest.json` | `064aaec9fd70021c395a17721a01585262b8324b4be5b69d70499b7b6438844d` |

Base of the registration: `origin/main` `5dfc6cdb`.
