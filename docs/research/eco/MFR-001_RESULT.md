# MFR-001 result: mutant-kill feedback retry (offline, Phase 1)

**Verdict: FALSIFIED.** Showing the maker its surviving mutants made the retried test kill **fewer** held-out mutants
than a plain "strengthen the assertions" retry: Δ = −0.142, 95 % CI [−0.250, −0.033]. The registered rule is "CI upper
< +0.15 → FALSIFIED", and it applies here. Negative-evidence entry **NE-013** is added in the same PR.

- **Protocol:** `MFR-001_PROTOCOL.md`, sha256 `2b98fae11aabd04b4864ac6e1d1b841ca4973b6edf825eab92fb428ff233c742`. It was committed in `eeadf691` and pushed before the first scored item, at 21-10 21:39 UTC.
- **Run:** 21-10 21:41 UTC to 22-10 10:52 UTC.
- **Raw per-item results:** `mfr-001/results.json`. It holds the prompts, the retried test diffs and every vitest outcome, and no secrets.

## Counts

| | |
|---|---|
| production rows (exports, graded < 1, 30 d) | 58 |
| rebuildable items (manifest) | 42: 39 maker commit, 3 `metadata.diff`. 16 not rebuildable: 13 without a source, 3 with < 6 fresh mutants |
| pre-treatment exclusions | 2 `no_shown_survivor`; 0 red at base; 0 infra |
| **scored pairs (= n per arm)** | **40** (acceptance ≥ 30: met) |
| infra runs | 0 of 80 |
| held-out leaks | 0 of 80 prompts (every prompt passed `assertNoLeak`; the prompts are in results.json) |
| prod fidelity (original test's kills on the 3 prod mutants = prod `graded.killed`) | 41 / 42 |

### Outcome classes per arm

| class | FEEDBACK | CONTROL |
|---|---|---|
| ok | 33 | 37 |
| timeout (no change) | 6 | 2 |
| no_change | 0 | 0 |
| out_of_scope | 1 | 0 |
| baseline_red | 0 | 1 |

## Primary endpoint

| | FEEDBACK | CONTROL |
|---|---|---|
| mean held-out kill (ITT, n 40) | **0.325** | **0.467** |
| baseline-red rate | 0.000 | 0.025 |
| shown-mutant kill (manipulation check) | 0.808 | 0.533 |
| original test, held-out kill (both arms start here) | 0.150 | 0.150 |

- **Paired Δ (F − C) = −0.142.** Bootstrap 95 % CI [−0.250, −0.033] (10 000 resamples, seed 20261022). One-sided sign-flip permutation p = 0.996 (H1: Δ > 0).
- **Decision (`lib.mjs decide`): FALSIFIED.** The CI upper bound of −0.033 is < +0.15. The SUPPORTED conditions fail on every count: Δ < 0.15 and the CI lower bound ≤ 0. The baseline-red condition alone would have held.

## Secondary (registered)

- **Operator's between-item parity analysis.** This takes FEEDBACK values from the 17 feedback-parity items and CONTROL values from the 23 control-parity items. Δ = −0.087, CI [−0.295, +0.127], p = 0.827. The direction is the same, and the result is underpowered, as expected at 17 / 23.
- **Run order.** When feedback ran first (17 items), F 0.333 vs C 0.529. When control ran first (23 items), F 0.319 vs C 0.420. Control is ahead in both orders, so the effect is not an order artefact.

## Descriptive, not registered

These are reported for interpretation only and play no part in the decision.

- **Paired wins.** F > C in 7 pairs, F < C in 16, and 17 ties.
- **Both runs `ok` (32 pairs).** Δ = −0.146, CI [−0.271, −0.031]. The deficit is not caused by the extra feedback timeouts.
- **Improvement over the original test's held-out kill.** FEEDBACK improved it in 17 / 40 items, CONTROL in 23 / 40.
- **Size of the change.** The median retried-test diff added 90 lines under FEEDBACK and 206 under CONTROL.

**Reading.** The feedback was used: the shown-mutant kill rose to 0.81, against 0.53 for control. The maker wrote narrow assertions aimed at the listed mutations and then stopped. The generic instruction produced broader tests, and those caught more of the unseen mutants. This is teaching to the oracle. The held-out set is exactly what exposed it.

## Cost and guardrails

| | |
|---|---|
| wall time | 12.79 h for the items, plus 20 min of queue pauses. The orchestrator paused twice, 1 × 5 min and 3 × 5 min, while a production remote maker job was queued or claimed. |
| GPU time | ≤ 12.08 h. This is the sum of the atomic-agent maker wall time, an upper bound on llama-router busy time. Scoring runs are CPU only. |
| maker terminations | 65 × `exit:0`, 15 × timeout at the 900 s cap |
| model | qwen38-27b (llama-router, loaded); gpt-oss-120b and qwen36-a3b were unloaded |
| cloud tokens | 0 |
| prod writes | 0. The touched-row fingerprints before (21-10 21:39 UTC) and after (22-10 10:52 UTC) are identical: `worker_leases` 58 rows, sha256 `1754a5f1…`; `skill_outcomes` 53 rows, `546f7dce…`; `judgments` 45 rows, `ef99b285…`. The table totals grew from normal prod activity (`worker_leases` 4096 → 4178, `skill_outcomes` 1302 → 1323, `judgments` 19747 → 19888). |
| djimitflo-live | Only the read-only SELECT probes ran there: the export, the queue check and the fingerprint, each on a READONLY better-sqlite3 handle. No experiment code ran there. |
| VPS → workstation | never. The Mac orchestrated both hosts. |
| workstation | Containers were labelled `djimitflo-gym-host=mfr-001`, niced to 10 and capped with `--cpus 8`, one item at a time. The gym worker, kb-sync, host agent, llama-router and atomic shim units were not touched, and all were active at the end. `~/mfr-001` and the `mfr-001-npm` volume were deleted afterwards (the protocol rollback). |

## Deviations and notes

1. **Paired crossover instead of a between-item split.** This was decided and registered before scoring; see the protocol's Design section. Parity splits the 42 rebuildable items 17 / 25, so a between-item design cannot reach ≥ 30 per arm. Every item therefore ran both arms, with parity deciding the order. The operator's parity design is reported above as the registered secondary analysis.
2. **Item source.** Only 10 of the 58 leases carry `metadata.diff`; MAKER_DIFF_CAPTURE was enabled late. The original test was therefore rebuilt from the loop's own maker commit, found by `maker lease <id>` on the draft-PR heads. That commit is pinned by the sha256 of its diff. For all 7 leases with both sources, the commit's test text equals the stored diff. 13 leases had neither source and are not items.
3. **Fresh mutants.** Production graded with `targetMutants(…, runId, …)` at k = 3. The 6 MFR mutants are the next fresh ones from the same generator and seed base; the production 3 are excluded from both S and H.
4. **Environment.** The workspace builds (`@djimitflo/shared`, `@djimitflo/agent-catalog`) run after `npm ci`, as in production's `test:changed`. The pre-registration smoke run found this was needed, and the fix is part of the pinned `run-item.mjs`. Fidelity of 41 / 42 confirms the rebuild reproduces production's graded kills. The one mismatch, `0086ab10` (`operator-push.ts`: 0 kills vs 1 in prod), mutates an env-var default, which plausibly depends on the prod environment.
5. **Extension.** None. The verdict is FALSIFIED, so the pre-registered INCONCLUSIVE extension does not apply.
6. **Smoke run.** One smoke run on a non-item (`gym-mutants.ts` at `main`) preceded registration and is not scored.

## Note on the raw data

Maker-written tests in `mfr-001/results.json` used fake secret fixtures to test redaction: an AWS key shape (`AKIA` + 16
capitals) and a Slack bot token shape (`xoxb-` + letters). They are replaced by `AWS_KEY_FIXTURE_REDACTED` and
`SLACK_TOKEN_FIXTURE_REDACTED` (2 occurrences each) so secret scanning stays strict; neither was a real credential and the
substitution does not affect any score.

## Pre-registration evidence

The branch was squashed to one commit to keep secret scanning clean (see above). The original pre-registration commit is
kept as tag `prereg/mfr-001` → `eeadf69134d49545e1af2ad598c857a8d35c1e57`, committed 2026-10-21T21:39:06Z; the first
item started at 2026-10-21T21:42:06Z (`results.json`), i.e. the protocol (sha256 `2b98fae1…`) predates every scored item.
