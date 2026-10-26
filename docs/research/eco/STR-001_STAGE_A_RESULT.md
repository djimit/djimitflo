# STR-001 Stage A result: the strengthen-retried test kills more independent mutants (offline re-scoring)

**Verdict: SUPPORTED.** Re-scored against Stryker mutants of the target, the MFR-001 CONTROL test ("strengthen the
assertions") kills a larger share of mutants than the original test. No maker prompt ever saw these mutants.

- **Effect.** Δ = **+0.316**, 95 % CI [+0.233, +0.402]. 36 units went up, 3 went down and 1 stayed the same. The exact sign test gives Holm-adjusted p = 1.8 × 10⁻⁸.
- **Rule.** The registered rule is Holm p < 0.05 and CI lower > +0.05, with ≥ 30 units. It holds.
- **Second family.** The fresh gym-mutant family agrees: Δ = +0.343, CI [+0.252, +0.439].

The gain is **strongly tied to how much test code the retry added**. About 80 % of the newly killed Stryker mutants sit in code the
original test never executed. Stage A shows that the retried artefact is a better mutant-killer. It does not show that
"strengthen" beats asking again from scratch: that is Stage B.

- **Protocol.** `STR-001_STAGE_A_PROTOCOL.md`, sha256 `87c8927f2278124784c8c0d9b0d4e562d1440e10f20e79d5d3ad05fc3b7f3a47`.
  - It was committed in `e7435b1d` at **2026-10-22T20:34:58Z**, pushed, and tagged `prereg/str-001-a`.
  - The first unit started at **2026-10-22T20:35:17Z**, 19 s later (`str-001/results.json`). The protocol predates every scored unit.
- **Run.** 20:35:17Z to 21:45:45Z on the workstation CPU: 40 units, one at a time. There were 0 infra units and 0 harness errors.
- **Raw data.**
  - `str-001/manifest.json` holds the units, both tests, the mutant descriptors and the redactions.
  - `str-001/results.json` holds the per-unit results, every family (a) vitest outcome and every Stryker status, plus the summary.
  - `str-001/posthoc.json` holds the post-hoc analyses below.

## Counts

| | |
|---|---|
| units (MFR-001 items that reached the arms) | 40, of 42 MFR items; the 2 `no_shown_survivor` items never ran an arm |
| pre-treatment exclusions (original red at base) | 0 |
| strengthen classes | 37 `ok`; 2 `no_retry` (`18706993`, `2df27db1`: the MFR control timed out with no change); 1 `baseline_red` (`204a90cf`: the retried test fails on the real target, as it did in MFR-001) |
| family (b) Stryker: units / mutants | 40 / 10 912 valid mutants in the originals' runs (median 207 per unit, range 44–1 043). 298 dropped because their content equals an MFR-001 mutant; 3 583 dropped as Ignored (mutator set) or invalid. 0 Stryker infra runs (77 runs) |
| family (a) fresh gym mutants: units / mutants | 40 / 423 (31 units have 12, 9 have 3–9). Disjoint from all 360 MFR-001 mutants, by key and content, asserted at build and on the workstation |
| Stryker / runner pin | `@stryker-mutator/core` and `vitest-runner` 10.0.0 at every base; the repo mutator set matched at every base |

## Primary endpoint (family (b), Stryker)

| | original | strengthen | Δ | 95 % CI | up / down / same | sign p | Holm p |
|---|---|---|---|---|---|---|---|
| **(b) Stryker, ITT, n 40** | 0.158 | 0.474 | **+0.316** | [+0.233, +0.402] | 36 / 3 / 1 | 1.8 × 10⁻⁸ | **1.8 × 10⁻⁸** |
| (a) fresh gym, ITT, n 40 | 0.166 | 0.510 | +0.343 | [+0.252, +0.439] | 31 / 1 / 8 | 7.7 × 10⁻⁹ | 1.5 × 10⁻⁸ |

- **Decision (`lib.mjs decide`): SUPPORTED.** The Holm-adjusted p of 1.8 × 10⁻⁸ is < 0.05, the CI lower bound of 0.233 is > 0.05, and n is 40, which meets the ≥ 30 acceptance.
- **The downs.** Under ITT all 3 "down" units in (b) are the 2 `no_retry` and the 1 `baseline_red` unit, which score 0. No `ok` retried test killed fewer Stryker mutants than its original: 36 up, 1 same.
- **Comparison with the exploratory observation.** MFR-001's CONTROL went from 0.150 to 0.467 held-out kill, on 3 gym mutants per unit. The independent families reproduce it closely: Stryker 0.158 → 0.474, fresh gym 0.166 → 0.510.

### Sensitivity (registered)

| | (b) Stryker Δ [CI] | (a) gym Δ [CI] |
|---|---|---|
| S1: `no_retry` keeps the original (d = 0) | +0.322 [+0.240, +0.403], 36 / 1 / 3 | +0.347 [+0.256, +0.442] |
| S2: per protocol, `ok` only (n 37) | +0.349 [+0.264, +0.431], 36 / 0 / 1 | +0.376 [+0.283, +0.471] |

## Size control (registered, descriptive)

The retried tests added a median of 202 `+` lines (38 retried tests).

| | (b) Stryker | (a) gym |
|---|---|---|
| small-retry subset (≤ 202 added lines, n 19): Δ [CI], up / down / same | **+0.200 [+0.117, +0.296]**, 18 / 0 / 1 | +0.200 [+0.123, +0.282], 13 / 0 / 6 |
| OLS d ~ a + b · (added lines / 100), n 40: intercept a [CI] | −0.016 [−0.104, +0.079] | −0.021 [−0.152, +0.095] |
| slope b per 100 added lines [CI] | **+0.167 [+0.127, +0.222]** | +0.183 [+0.126, +0.261] |
| companion: slope per added `expect(` [CI] | +0.0067 [+0.0047, +0.0088] | +0.0066 [+0.0042, +0.0090] |
| median Δ per 100 added lines | +0.146 | +0.165 |
| extra mutants killed per 100 added lines (aggregate) | 35.4 | 1.7 |

**Reading, by the rule fixed in the protocol.** The small-subset CI lower bound is > 0 in family (b), so the gain is **not explained by size alone**. Retries that added at most 202 lines still gained +0.20.

The regression says the same thing more sharply: the gain is close to proportional to the added test code. The slope is about +0.17 kill share per 100 added lines, and the intercept is ≈ 0, with its CI including 0.

So a retry that adds little test code gains little. The data cannot separate "more assertions" from "better assertions" beyond that. Every retry that gained added test code, and the gain scales with it.

## Post-hoc (not registered; added after scoring started; no effect on the verdict)

### 1. Timeout handling

The registered rule counts a hung run as a kill. That is the MFR-001 convention, and Stryker counts Timeout as detected, as in `scripts/mutation-gain.mjs`.

Production `graded-fitness.ts mutantKill` works differently: there a timeout is a **skip reason, never a score**. The protocol's "as in graded-fitness" wording in the family (a) section is an erratum: the convention is MFR-001's, not production's. A review after scoring had started raised this. The primary rule is therefore unchanged, and the variants are reported here. The code is `scripts/str-001/posthoc.mjs`.

| timeouts | original | strengthen |
|---|---|---|
| (b) Stryker `Timeout` statuses | 8 of 10 912 (0.07 %) | 42 of 10 453 (0.40 %) |
| (a) gym runs that hung (180 s cap) | 0 of 423 | 4 of 396 (1.0 %) |
| baseline hung on the real target | 0 | 0 |

| variant | (b) Stryker Δ [CI] | (a) gym Δ [CI] |
|---|---|---|
| registered (timeout = kill) | +0.316 [+0.233, +0.402] | +0.343 [+0.252, +0.439] |
| V1: a mutant that timed out under either test is left out of the unit | +0.315 [+0.230, +0.401], Holm p 1.8 × 10⁻⁸ | +0.339 [+0.247, +0.433], Holm p 1.5 × 10⁻⁸ |
| V2 (prod-like, family (a)): a unit with any hung run is skipped (n 37) | — | +0.331 [+0.234, +0.429] |

The verdict does not depend on the timeout convention.

### 2. Where the Stryker gain comes from (37 `ok` units)

| original → strengthen | mutants |
|---|---|
| NoCoverage → Killed / Timeout | **2 257** |
| Survived → Killed / Timeout | **561** |
| Killed / Timeout → not killed | 1 |
| already killed by the original | 1 427 |

- **New coverage.** 80 % of the newly killed mutants sit in code the original test never executed. The retry mostly added tests for functions or branches the original left untouched.
- **Stronger assertions.** The other 20 % are mutants in code the original already executed but did not check. Of the 1 322 mutants that survived the original, 42 % are now killed.
- **Reading.** Both mechanisms are present, and coverage dominates. This matches the size result: the gain comes mostly from **more** test, and partly from **stronger** checks on code that was already run.

## What Stage A cannot say

- **No fresh-attempt comparison (Stage B).** Stage A compares a test with its own retry. It does not compare a strengthen retry with a same-budget fresh write-test attempt, or with a longer first attempt. Whether "strengthen" beats simply spending the budget again needs new maker runs, and therefore GPU. That is Stage B.
- **One maker family.** The original tests came from production makers (exports lane). All the retries came from atomic-agent 0.6.5 with qwen38-27b (MFR-001). The 40 units are the full MFR population, not a random sample of leases.
- **Kill share only.** Bigger tests may also be slower, more brittle or more redundant. Stage A measures kill share only.

## Cost and guardrails

| | |
|---|---|
| wall time | 1.17 h for the 40 units (20:35:17Z–21:45:45Z), plus about 10 min of pre-registration smoke |
| CPU | **2.09 CPU-hours** (user + sys of every container command, measured with `times`; 0 unmeasured runs), niced 10, `--cpus 8`, Stryker concurrency 4, one unit at a time |
| GPU | **0**. No maker and no model endpoint ran; there was no llama-router, atomic-agent or cloud call. GPU utilisation was 0 % / 6 MiB before and after |
| prod | 0 reads and 0 writes; no prod data was needed. Nothing ran in `djimitflo-live` |
| VPS → workstation | never. The operator Mac orchestrated over SSH |
| workstation | Own clone and throwaway worktrees under `~/str-001`. Containers were labelled `djimitflo-gym-host=str-001` and used their own `str-001-npm` volume. The image was `str-001-runner:1`, which is the gym runner image plus `procps` (Stryker needs `ps`, which the smoke found). The gym worker, its repo and containers and the systemd units were not touched. `llama-router`, `atomic-shim`, `atomic-agent-serve`, `djimit-host-agent` and `ollama` were active at the end. Afterwards `~/str-001`, the `str-001-npm` volume and the `str-001-runner:1` image were deleted (the protocol rollback) |

## Deviations and notes

1. **Timeout wording.** This is an erratum, covered in post-hoc section 1. The protocol text says hung counts as killed "as in graded-fitness and MFR-001". It matches MFR-001 only; production skips on a timeout. The scored rule is exactly the registered `lib.mjs`, and the production-like variants do not change the result.
2. **Redaction.** One retried test (`f3b02803`) tests secret redaction using fake fixtures: an AWS key shape and a Slack bot token shape, 2 of each. In the committed `manifest.json` they are replaced by `AWS_KEY_FIXTURE_REDACTED` and `SLACK_TOKEN_FIXTURE_REDACTED`. Scoring used the unredacted local copy, which matches the recorded sha256 and the MFR-001 `retried_test_sha256`. `results.json` holds no test text.
3. **No amendments.** The pinned scripts ran unchanged, and their sha256 was verified on the workstation before the run.

## Reproduce

- **Manifest.** `npx tsx scripts/str-001/build-manifest.mjs --items <exp/mfr-001 items.json> --raw <MFR raw results> --repo <clone> --out … --local …`. It is deterministic: rebuilding gives the pinned sha256 `064aaec9…`.
- **Run.** On the workstation: `setsid nohup nice -n 10 node run-all.mjs manifest.local.json results`.
- **Score.** `node scripts/str-001/score.mjs <results> docs/research/eco/STR-001_STAGE_A_PROTOCOL.md`, then `node scripts/str-001/posthoc.mjs <results>`.
- **Unit test.** `packages/server/src/__tests__/str-001-harness.test.ts`, 11 tests on fake data. It covers the decision rule, the mutant-family disjointness check, Stryker mutant identity and content, the sign test, Holm and the classes.
