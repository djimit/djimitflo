# DI-001: reviewer leases with no verdict

**Status:** diagnosis complete; challenger built behind a flag (`LOOP_REVIEWER_STRATEGY=bounded`, default off).
**Window:** 2026-09-13 .. 2026-10-14 (prod `djimitflo-live`, read-only better-sqlite3 plus the lease stdout files).
**Cut-off:** deploy `3eebe3bb` at 2026-10-09T18:07Z. It contains #716 (inline check logs, no installs/re-runs, last-valid-verdict parser) and #719.
**Frozen manifest:** `reviewer-no-verdict-manifest.json`, sha256 `758bc1b07215647c04c3c50350d76dbb36e754693017cbd708805a5f41e0d2fd`. It holds 240 reviewer leases, each with its class, tokens, steps, finish reason, model, F2 arm and independent label.

Population: `worker_leases` with role `checker` or `security_checker`, a runtime other than `manual`, and status `completed` or `failed`. Manual reviewers (976 checker + 202 security, no model) are excluded.

A **valid verdict** is a completed lease whose output contained a parsed `accepted`, `needs_revision` or `rejected`. A verdict is never inferred. An explicit `insufficient_evidence` is a parsed verdict, but it is not decisive.

## 1. Reconciling "39 leases, 12.8 M tokens"

The capability matrix figure is only partly reproducible:

- **48 no-verdict leases on 33 runs:** 27 opencode and 21 `remote`.
- The **token figure reproduces:**
  - the 22 *failed* opencode leases total 12.83 M;
  - all 27 opencode no-verdict leases total 12.90 M;
  - the 21 remote leases report no tokens at all.
- The count of 39 matches no filter I could find, so this doc uses the full set of 48.

**Token accounting.** On all 19 leases with stdout, `runtime_usage.total_tokens` equals the sum of the step totals exactly. The value is provider-reported (opencode `step_finish.tokens`), not estimated.

**Duplicate accounting.**
- **Between a retry and its parent:** none. Each retry is its own lease and opencode session with its own stdout.
- **Within one lease:** the total re-counts the context every step. Input plus cache-read is re-sent on each step, so a 28-step lease "uses" about 1.03 M while its largest single context is about 50 k. Output tokens total only 3.5–6 k per lease.
- **No source:** 29 leases have `usage_source: unknown`. Of these, 8 date from before 09-25 (stdout rotated away) and 21 ran on `remote`, which reports no tokens.

## 2. Classification (all 48)

| class (verified from stdout/stderr/metadata) | pre-#716 leases | runs | tokens (known/leases) | post-#716 |
|---|---|---|---|---|
| **token_budget**: `OPENCODE_MAX_RUN_TOKENS` brake at 1.0 M, 24–29 steps, context 17–20 k → 42–51 k per step, killed mid tool-loop (finish `tool-calls`); 10/10 also failed the read-only contract (`npm ci` / `npm install-scripts approve`) | 10 | 7 | **10.33 M** (10/10) | 0 |
| **exit1_after_verdict**: the model finished normally (`stop`) with a verdict (stdout: 4× accepted, 1× rejected; 2 leases whose stdout is gone left approving notes), but opencode exited 1; on the 5 with stderr it ends with opencode's permission ruleset (`external_directory` deny): they reached for check logs outside the worktree. The verdict is correctly discarded, because the gate requires exit 0. | 7 | 6 | 1.62 M (5/7) | 0 |
| **timeout**: 120 s (09-24) or 300 s (10-08) wall clock, killed mid tool-loop | 4 | 4 | 0.88 M (2/4) | 0 |
| **unparsed_verdict**: exit 0, verdict embedded in prose / backticks, not parsed before #716 (09272945 is the #716 fixture) | 3 | 3 | 0.05 M (1/3) | 0 |
| **input_missing**: "No diff available" (maker diff artifact absent), explicit insufficient_evidence or exit 1 | 2 | 2 | UNKNOWN | 0 |
| **infra_remote_runtime**: a remote maker made the reviewer `remote`, a maker-only executor ("Checker runtime failed", 0 steps). Fixed 10-07 (reviewer runtime = `LOOP_DAEMON_MAKER_RUNTIME`). | 21 | 11 | 0 reported | 0 |
| **malformed_output**: exit 0, 1 step, finish `stop`, and the only text part was a leaked tool-call fragment (`</arg_key><arg_value>…</tool_call>`) | 0 | 0 | — | **1** (d32721a7, 16 k) |
| **total** | 47 | 32 | 12.88 M | 1 (16 k) |

Classes the operator listed that do **not** occur:
- **Model truncation:** finish reason `length` appears 0 times. Every budget or timeout death ended on `tool-calls`.
- **Missing stop reason:** this only happens where there is no runtime output to read: the 8 old leases whose stdout is gone and the 21 remote leases, which ran 0 steps.
- **Cancellation:** 5 opencode reviewer leases were cancelled on 09-21, each with 0 tokens. None is in the no-verdict set.

**Repeated failure on the same input.** Run 5b91e689 accounts for 4 leases and 4.14 M tokens (checker, security, and both retries, all token_budget). Run 85bb0607 had a timeout plus a token_budget. Run c2935b19 had 2× exit1_after_verdict.

### Per-lease table

| # | lease | run | role | when (UTC) | era | class | tokens (lease) | src | steps | step1 → last step tok | max ctx/step | stop | dur s | retry_of |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | a5c7c554 | 6a40a902 | chk | 09-21 20:27 | pre | unparsed_verdict | UNKNOWN | unknown | - | - | - | stdout gone | 0 |  |
| 2 | e4ede41e | 62cecbc3 | sec | 09-23 17:52 | pre | input_missing | UNKNOWN | unknown | - | - | - | stdout gone | 60 |  |
| 3 | bd5716bc | 782b9702 | chk | 09-23 17:52 | pre | input_missing | UNKNOWN | unknown | - | - | - | stdout gone | 61 |  |
| 4 | 00841d03 | ea5a8ea0 | sec | 09-23 20:21 | pre | unparsed_verdict | UNKNOWN | unknown | - | - | - | stdout gone | 63 |  |
| 5 | 12a44dc3 | c2935b19 | chk | 09-23 22:45 | pre | exit1_after_verdict | UNKNOWN | unknown | - | - | - | stdout gone | 58 |  |
| 6 | 5c9e8d75 | c2935b19 | sec | 09-23 22:45 | pre | exit1_after_verdict | UNKNOWN | unknown | - | - | - | stdout gone | 38 |  |
| 7 | ad90ebea | 6b2617f0 | chk | 09-24 05:34 | pre | timeout | UNKNOWN | unknown | - | - | - | stdout gone | 120 |  |
| 8 | 850ee9df | 9be90b46 | sec | 09-24 06:34 | pre | timeout | UNKNOWN | unknown | - | - | - | stdout gone | 120 |  |
| 9 | 09272945 | 3d7dbc93 | sec | 10-02 19:54 | pre | unparsed_verdict | 51555 | runtime_stdout | 3 | 16327 → 18819 | 18532 | stop | 16 |  |
| 10 | a39f2d1f | 260479c5 | sec | 10-02 22:15 | pre | exit1_after_verdict | 344902 | runtime_stdout | 15 | 16738 → 25794 | 25070 | stop | 81 |  |
| 11 | 3e8924e1 | 5f103006 | sec | 10-03 20:15 | pre | exit1_after_verdict | 178083 | runtime_stdout | 7 | 16890 → 34455 | 34147 | stop | 33 |  |
| 12 | df683df9 | 9af58f8e | sec | 10-03 20:18 | pre | exit1_after_verdict | 662573 | runtime_stdout | 20 | 16024 → 47959 | 47631 | stop | 112 |  |
| 13 | bcbfec05 | 4b08aca9 | chk | 10-03 22:33 | pre | token_budget | 1028252 | runtime_stdout | 29 | 18422 → 48403 | 48220 | tool-calls | 154 |  |
| 14 | 115c6710 | 5eccf722 | sec | 10-03 23:37 | pre | token_budget | 1029797 | runtime_stdout | 25 | 18714 → 50940 | 50748 | tool-calls | 136 |  |
| 15 | e1dc2f39 | d62d8d57 | chk | 10-04 22:05 | pre | exit1_after_verdict | 203980 | runtime_stdout | 10 | 16949 → 24581 | 23979 | stop | 43 |  |
| 16 | 659857f5 | feb652a6 | chk | 10-04 22:32 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 17 | ff77a063 | feb652a6 | sec | 10-04 22:32 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 18 | d78f5b4f | 5a2442d5 | chk | 10-05 09:07 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 19 | 44368c70 | 5a2442d5 | sec | 10-05 09:07 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 20 | 481da995 | b7384207 | chk | 10-05 09:07 | pre | token_budget | 1031838 | runtime_stdout | 28 | 20423 → 42183 | 42042 | tool-calls | 134 |  |
| 21 | ab392638 | ea9fc50e | chk | 10-05 12:16 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 22 | a9788065 | ea9fc50e | sec | 10-05 12:16 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 23 | 7a7bb1be | 30cb2d26 | chk | 10-05 23:28 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 24 | 46a4e2b6 | 30cb2d26 | sec | 10-05 23:28 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 25 | a3f91d58 | 809e1d30 | chk | 10-06 07:48 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 26 | bc9db952 | 809e1d30 | sec | 10-06 07:48 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 27 | d6bf4497 | 4418f34d | sec | 10-06 07:48 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 28 | ecdc8b20 | 865f2ea0 | chk | 10-07 04:46 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 29 | 46993230 | 865f2ea0 | sec | 10-07 04:46 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 30 | 1af28464 | a0e8ebbc | chk | 10-07 04:47 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 31 | 543675a5 | a0e8ebbc | sec | 10-07 04:47 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 32 | 86a46ab8 | 2bc0935c | chk | 10-07 10:44 | pre | exit1_after_verdict | 227602 | runtime_stdout | 10 | 16588 → 26358 | 26138 | stop | 87 |  |
| 33 | 3299229d | 65255624 | chk | 10-07 12:43 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 34 | e7a72cb6 | 65255624 | sec | 10-07 12:43 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 35 | 724f79be | a115dad8 | chk | 10-07 12:44 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 36 | 7dd36a66 | a115dad8 | sec | 10-07 12:44 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 37 | b09c149c | edf524de | chk | 10-07 18:37 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 38 | 8884ed87 | edf524de | sec | 10-07 18:37 | pre | infra_remote_runtime | UNKNOWN | unknown | 0 | - | - | - | 0 |  |
| 39 | 5bf2c4ea | 85bb0607 | chk | 10-08 08:26 | pre | timeout | 715023 | runtime_stdout | 23 | 17587 → 37046 | 36714 | tool-calls | 300 |  |
| 40 | 249842e8 | 85bb0607 | sec | 10-08 08:26 | pre | token_budget | 1018335 | runtime_stdout | 27 | 17629 → 50014 | 49796 | tool-calls | 212 |  |
| 41 | defb5ca3 | b980f01b | chk | 10-08 08:26 | pre | timeout | 167167 | runtime_stdout | 8 | 17078 → 22176 | 22053 | tool-calls | 300 |  |
| 42 | 3c93355a | 3083115d | sec | 10-08 11:18 | pre | token_budget | 1040572 | runtime_stdout | 28 | 16736 → 49416 | 49274 | tool-calls | 150 |  |
| 43 | bf6ea073 | 587d310f | sec | 10-09 08:07 | pre | token_budget | 1041059 | runtime_stdout | 27 | 17321 → 50675 | 50391 | tool-calls | 112 |  |
| 44 | 709bdfed | 5b91e689 | chk | 10-09 08:27 | pre | token_budget | 1032964 | runtime_stdout | 29 | 19537 → 43195 | 43082 | tool-calls | 78 |  |
| 45 | 25114350 | 5b91e689 | sec | 10-09 08:27 | pre | token_budget | 1036690 | runtime_stdout | 26 | 19517 → 45689 | 45429 | tool-calls | 270 |  |
| 46 | d3f9e467 | 5b91e689 | chk | 10-09 09:02 | pre | token_budget | 1041760 | runtime_stdout | 28 | 19688 → 44383 | 43304 | tool-calls | 264 | 709bdfed |
| 47 | 8e7beb3a | 5b91e689 | sec | 10-09 09:11 | pre | token_budget | 1028472 | runtime_stdout | 24 | 19771 → 50109 | 49868 | tool-calls | 209 | 25114350 |
| 48 | d32721a7 | a4c792b9 | sec | 10-13 18:02 | post | malformed_output | 16386 | runtime_stdout | 1 | 16386 → 16386 | 16287 | stop | 5 |  |

## 3. Retry (LOOP_REVIEWER_RETRY_ENABLED): recovery and amplification

- **Retries dispatched: 3**, all on 10-09 before the #716 deploy. None since: 0 post-#716 reviewer leases qualified.
- **Recovered: 1 of 3.**
  - 69ecf575 retried security bf6ea073 and returned `accepted` in 74 k tokens. Run 587d310f was **verified**.
  - The other two (d3f9e467, 8e7beb3a, run 5b91e689) hit the token budget again, costing 2.07 M.
- **Amplification:** retry tokens divided by original tokens = 2.14 M / 3.11 M = **0.69×**.
- **The same-input → same-failure claim is not established:**
  - Of the 2 retries whose run could still pass, 1 recovered.
  - The third retry (8e7beb3a) belonged to a run whose checker had already failed for good.
  - Skipping retries after token_budget/timeout would have saved 1.04 M but lost a verified run. **Not built.**

## 4. Metrics (operator set): baseline on prod history

**Labels.**
- **Independent labels** are settled merge survival only.
- **Not independent:**
  - A PR merge happens after the operator has read the verdict.
  - The run gates contain the verdict.
  - Every `outcome_attribution` "annotation" is rule-derived from those gates.
- **operator_label judgments:** 56 exist, but all are for prescreen; none covers a reviewer subject.
- **Labelled verdicts:** the reviewer verdicts with an independent label are **4**, all `accepted` on 2 settled-survived PRs.
- **Pending:** 132 accepted verdicts on 66 open or merged PRs are still waiting for survival.
- **Rejections:** the 10 rejecting verdicts have no PR, so they can never be labelled this way.

| metric | pre-#716 (157 opencode leases) | post-#716 (62 leases, 4.2 d) |
|---|---|---|
| valid verdicts / M reviewer tokens (bootstrap 95 % CI, leases with tokens) | **3.03** [2.42, 3.78] (109 / 35.95 M, n = 127) | **17.71** [15.44, 20.51] (61 / 3.45 M, n = 62) |
| coverage: decisive verdict / reviewer lease that ran | 131 / 157 = 83 % (131 / 178 = 74 % incl. remote) | 61 / 62 = 98 % |
| timeout rate | 4 / 157 = 2.5 % | 0 / 62 (95 % upper 4.8 %) |
| token_budget rate | 10 / 157 = 6.4 % | 0 / 62 (95 % upper 4.8 %) |
| schema failure rate (unparsed + malformed) | 3 / 157 = 1.9 % | 1 / 62 = 1.6 % |
| retry amplification | 0.69× (3 retries, 1 recovered) | no retries |
| median tokens / valid verdict lease; median steps | 170 k; 7 | 42 k; 2 |
| independent verdict correctness | **INSUFFICIENT** (n = 4, all correct) | **INSUFFICIENT** (n = 0 settled) |
| false approval rate | **INSUFFICIENT** (n = 4 labelled approvals, 0 regressed) | **INSUFFICIENT** (n = 0) |
| false rejection rate | **INSUFFICIENT** (n = 0: 10 rejections, none has a PR) | **INSUFFICIENT** (n = 0) |
| cost per independently correct verdict | **INSUFFICIENT** (n = 4) | **INSUFFICIENT** (n = 0) |

**Caution about the 5.8× efficiency gain.**
- **Distribution:** post-#716 verdicts are 61 / 61 `accepted`, against 10 / 131 non-accepting before (hypergeometric P(0 of 61 | same rate) = 0.020).
- **Reviewer effort:** reviewers now take 2 median steps and read the inlined check logs instead of re-running them.
- **Interpretation:** the drop in no-verdict waste is real. Whether the cheaper reviewer still catches bad changes cannot be shown with the labels that exist. A falling rejection rate is exactly what a rubber stamp would also produce.
- **Next measurement:** run seeded-defect (mutant) diffs through the reviewer path. Merge survival will not separate the two for weeks.

**F2 (running randomised experiment; analysed only, assignment and arms untouched).** Checker leases since 10-10:

| arm | model | leases | valid | rate |
|---|---|---|---|---|
| same | glm-5.2 | 15 | 15 | 22.9 / M [17.4, 29.0] |
| cross | kimi-k3 | 12 | 12 | 11.7 / M [9.2, 15.0] |

- **Cost:** kimi uses about 2× the tokens per verdict.
- **Reliability:** neither arm has a no-verdict lease, so no reliability difference can be measured.
- **Correctness:** **INSUFFICIENT** for both arms (n = 0 labelled).

## 5. Interventions ranked by verified avoidable tokens

"Verified avoidable" means tokens spent in the classified leases that the intervention would provably not have spent. The ranking uses the 30-day window and does not count probabilistic recoveries.

| # | intervention | verified avoidable | cost / risk | status |
|---|---|---|---|---|
| 1 | #716 prompt + parser (no installs/re-runs, inline logs, last-valid verdict) | the token_budget + exit1 + timeout + unparsed classes: 12.88 M spent; 0 recurrences in 62 post leases. Observational, not counterfactual. | the rejection-rate caution above | shipped 10-09 |
| 2 | **no security review once the checker has no verdict** (the run's `checker_verdict` gate can no longer pass) | **3.97 M** on 9 runs. 3.08 M of it was itself no-verdict security spend (249842e8, 25114350, 8e7beb3a). 0.88 M bought 6 `accepted` security verdicts on runs that were already failing. | loses a security verdict on a run that fails anyway. The verdict is not a label: those runs have no PR. | **built**, flag off |
| 3 | skip the same-input retry after token_budget/timeout | 2.07 M, of which 1.03 M overlaps #2, so **1.04 M** net | loses 69ecf575 → run 587d310f verified (recovery 1 of 2 eligible) | not built: the data contradict it |
| 4 | remote-as-reviewer infra | 0 reported tokens (21 leases) | — | fixed 10-07 |
| 5 | malformed / unparsed output | 0.07 M | — | classification only (below) |

**Post-#716 verified avoidable expenditure is 16 k tokens: one lease, which no candidate would have avoided.**

## 6. The challenger (`LOOP_REVIEWER_STRATEGY=bounded`, default off)

**Change** (`loop-daemon.ts`): after the checker dispatch, including its one retry, the daemon checks the checker leases of the active maker. If none is `completed` with a decisive verdict, it does not dispatch the security checker. Instead it records `security_checker_dispatch_skipped`, carrying the checker's `reviewerSubReason`.

**What stays the same:**
- The security lease stays `prepared` without a verdict, the same as the existing `checker_dispatch_skipped` path.
- The gates are unchanged. `verifyLoopRun` still fails the run on `checker_verdict`.
- Attribution stays `reviewer_failure` with the checker's sub_reason. `checker_verdict` is evaluated before `security_checker_verdict`.
- With the flag unset, behaviour is identical to today.

**Out of scope:**
- Same-input retries: unchanged (see #3).
- A checker that said `rejected` or `needs_revision` still gets its security review. That verdict is information, not a missing one.

**Classification fix** (always on; additive metadata, no routing effect):
- **The gap:** `executeChecker` stores `insufficient_evidence` both when the reviewer says so and when nothing parses. So #816's `unparsed_verdict` could never fire, and d32721a7 was filed as `insufficient_evidence`.
- **The fix:** `verdict_parsed` (from `LoopService.checkerVerdictParsed`) is now stored on the lease, and `reviewerSubReason` uses it.
- **Unchanged:** the stored verdict and the gates. Rows written before this field keep their old classification.

**Guardrails as tests** (`reviewer-bounded-strategy.test.ts`, `reviewer-budget-verdict.test.ts`), replaying the prod failure strings of 5b91e689, 85bb0607 and 587d310f, and the d32721a7 stdout shape:
- the skip happens only when the checker has no verdict;
- a checker retry that recovers, and the security checker's own retry, are unchanged;
- after a rejecting checker, the security review still runs;
- a missing verdict stays insufficient_evidence and the attribution stays `reviewer_failure` (never accepted, rejected or a maker loss);
- no hidden fallback: no new lease, reviewer, runtime or model;
- with the flag unset, the baseline is unchanged;
- an invalid verdict (`approved`, the echoed format template, a tool-call fragment) is never parsed as valid.

**Expected effect (estimate, labelled).**
- **Post-#716 point estimate: 0 tokens / 30 d.** None of the 31 post-#716 checker leases lacked a verdict.
- **Upper bound (rule of three):** 3 / 31 ≈ 9.7 % × about 215 checker leases / 30 d × 52 k mean security tokens ≈ **≤ 1.1 M / 30 d**.
- **If the pre-#716 failure mode returns:** about 4 M / 30 d (the observed 3.97 M).
- The flag is a guard against regression, not a source of savings today.

## 7. Pre-registered acceptance criteria (shadow, then A/B)

1. **Manifest:** this file's manifest sha256 is frozen. A/B arms are assigned by `sha256('reviewer-bounded:' + goal_id)`. The salt is distinct from F2's, and F2's assignment is not read or changed.
2. **Shadow first** (flag off): count the runs where the skip *would* fire (checker without a decisive verdict while the security checker was dispatched) and the security tokens they spent.
   - **INSUFFICIENT** until n ≥ 10 such runs.
   - No token effect may be claimed before then.
3. **Primary metric:** valid decisive verdicts per M attributable reviewer tokens, per arm, with a bootstrap 95 % CI over runs.
   - **Adopt only if** the CI excludes 0 on the improving side.
4. **Guardrails** (any one rejects the challenger):
   - (a) a bounded-arm run reaches `verified` without an accepted checker **and** an accepted security verdict. This is impossible by gate construction; it is audited anyway.
   - (b) a skipped run later becomes `verified` in the same run.
   - (c) the bounded arm's reviewer_failure rate exceeds the baseline's by more than 2 percentage points.
   - (d) any security verdict is coerced (a stored decisive verdict on a lease that did not parse one).
   - (e) the false approval rate rises on seeded-defect holdouts. Report it INSUFFICIENT with n until each arm has ≥ 20 labelled defects.
5. **Secondary metrics,** reported with n and INSUFFICIENT where labels are fewer than 20: independent correctness (merge survival / seeded defects / operator label), false approval and false rejection rates, timeout rate, schema failure rate (now measurable through `verdict_parsed`), retry amplification, and cost per independently correct verdict.
