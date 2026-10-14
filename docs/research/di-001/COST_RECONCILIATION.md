# Cost reconciliation: capability-matrix figures re-derived (2026-10-14)

Scope: the four cost figures in the capability matrix of 2026-10-14 (cost per verified task baseline). I re-derived each one independently from the immutable execution records, then recomputed it with the versioned ledger in `packages/server/src/services/cost-ledger.ts` (`costPerVerified`).

**Method**
- Read-only probes against `djimitflo-live:/data/djimitflo.sqlite` (`{readonly:true}`).
- First pass: raw SQL over `worker_leases`, `llm_model_calls`, `judgments`, `loop_runs`, `self_improvements` and `skill_outcomes`.
- Second pass: the compiled ledger code from this branch.
- The probe files were deleted from the container and the VPS afterwards.

**Window**: 2026-09-13T22:37Z → 2026-10-13T22:37Z (30 d, the matrix window).

**Lost window**: 2026-10-11T04:16:22.715Z → 2026-10-12T16:43:39Z, 36.5 h of 720 h. Source: `docs/research/RECOVERY-2026-10-12.md`.
- Every table has 0 rows in it (for example, 0 leases).
- Usage and outcomes from those hours are **UNKNOWN, not zero**.
- Every count below is a lower bound for the window.
- The ledger lowers the coverage of every source by this share (0.949 of the window remains).

Conventions:
- UNKNOWN means not determinable from the records, and is reported as null, never 0.
- "Reconciled" means re-derived independently and compared.
- Token figures are provider- or runtime-reported totals. No estimator exists anywhere in the pipeline, so `tokens_estimated` is always null.

## Reconciliation table

| # | Figure | Matrix value | Re-derived value (raw SQL, matrix definition) | Ledger value (versioned) | Verdict |
|---|---|---|---|---|---|
| 1 | Task-path lease tokens, 30 d | 134.1 M | **134,115,559**: cloud 133,808,851 + local 306,708; 632 non-manual leases, 360 with tokens | population-first numerator `cost.population@1`: 125.10 M lease + 1.43 M judgment = **126.53 M**, coverage 0.818 | **Reconciled.** 9.0 M sits on leases outside the population: 8.71 M on 111 leases of 89 runs with no proposal, and the rest on runs of proposals created before the window. |
| 2 | Tokens per merged PR | **3.53 M** (134.1 M / 38) | **3.529 M** = 134,115,559 / 38 | `cost.per_merged_pr@1`: **3.33 M** (all usage) / **3.29 M** (lease only), lower bound, coverage 0.818. Successful-only contrast: 0.70 M | **Reconciled arithmetically.** The definitions differ: the matrix divides all lease tokens in the window, including runs without a proposal, by merged PRs. The ledger fixes the population first. |
| 3 | Share of task tokens on runs without verification | **57.6 %** (72.2 M of 125.4 M) | **57.56 %**: by the proposal status of the run (non-verified 72,186,969 of 125,406,814 goal-linked) | `cost.unverified_run_share@1`, by the run's own maker outcome: **57.8 %** window (72,607,265 / 125,637,624); **57.1 %** population (70,656,296 / 123,686,655) | **Reconciled.** The two definitions agree within 0.7 pp. Failed retries of a proposal that verified later count as "verified" spend in the matrix definition and as unverified in the run definition. |
| 4 | Reviewer tokens without a verdict | **12.8 M** on 39 failed leases (4 timeouts) | **12,829,069** on 22 failed opencode reviewer leases (17 report tokens, 4 timed out), plus 21 failed remote reviewer leases with tokens UNKNOWN | `cost.reviewer_no_verdict@1`: **12,897,010** = 32.7 % of 39,392,234 reviewer tokens (adds 5 completed `insufficient_evidence` at 67,941 and 5 cancelled with tokens UNKNOWN) | **Tokens reconciled exactly; lease count not.** I find 22 failed opencode + 21 failed remote = 43, not 39. The 4 timeouts match. |
| 5 | Maker double count | +10.55 M since 10-12 | **10,552,279**: 22 `llm_model_calls` rows, consumer `maker`, 2026-10-12T16:57:17Z → 10-13T22:35:45Z. Their sum equals the runtime_usage of the same 22 maker leases (18 rows equal one-to-one; 4 remote rows null on both sides) | `efficiency.cloud_tokens` v1 146,992,097 → v2 136,439,818 (Δ 10,552,279) | **Reconciled exactly.** This is an ACCOUNTING_CORRECTION. |

### Cohorts

**Population** (`cost.population@1`): 1,322 proposals created in the window.

| Status | Count |
|---|---|
| verified | 73 |
| regressed | 56 |
| infra_failed | 21 |
| no_change | 15 |
| archived | 1,115 |
| open (needs_more_evidence 37, needs_grounding 5) | 42, censored |

The population has 170 runs and 69 loop PRs.

**Pipeline-verified.**
- n = 73.
- The matrix cohort (status verified, updated in the window) and the population's verified members are **the same 73 proposals**: all 73 were also created in the window.

**Merged PRs.**
- n = 38: 38 runs, 38 distinct proposals, 0 runs without a proposal.
- Overlap with pipeline-verified: 35 of the 38 belong to verified proposals. The other 3 are `needs_more_evidence`, so a human merged them before the pipeline verified them.
- Censored: 31 PRs of runs in the window are still open. The matrix said 30; a later poll moved one PR into "open".

**Surviving PRs.**
- n = 2, a subset of the merged cohort.
- **36 of the 38 merged PRs are still inside the 14-day survival window** (MERGED_SURVIVAL_PENDING). They are censored, not failures. Per surviving PR is therefore not reportable.

**Reviewer verdicts.**
- 184 cloud reviewer leases completed with accepted, needs_revision or rejected.
- There are 53 reviewer leases without a valid verdict: 32 cloud and 21 remote. The remote leases report no tokens.

## Corrected baseline per cohort (30 d, ledger `cost.*@1`, tokens)

| Cohort (metric) | n | Censored | Per unit, all attributable usage | Lease only (task path) | Successful-only contrast (survivorship-biased) | Coverage |
|---|---|---|---|---|---|---|
| Verified task (`cost.per_verified_task@1`) | 73 | 42 open members | **1.73 M** (lower bound) | 1.71 M | 0.73 M | 0.818 |
| Valid reviewer verdict (`cost.per_valid_reviewer_verdict@1`) | 184 | none | **214 k** (lower bound) | 214 k | 144 k | 0.884 |
| Merged PR (`cost.per_merged_pr@1`) | 38 | 31 open PRs | **3.33 M** (lower bound) | 3.29 M | 0.70 M | 0.818 |
| Surviving PR (`cost.per_surviving_pr@1`) | 2 | 36 pending | 63.3 M (n = 2, not reportable) | 62.6 M | 0.98 M | 0.818 |

**Other parts of the numerator (all UNKNOWN unless stated)**

| Part | Status | Detail |
|---|---|---|
| Local tokens | **0.32 M, coverage 0.008** | 1 of 139 remote leases reports usage; atomic reports none. |
| Local GPU energy, task path | **0.75 kWh, job coverage 0.297** | Per unit: UNKNOWN (INSUFFICIENT_EVIDENCE, below 0.8 coverage). The link from a job to a population member is not stored, so this figure is window-wide. |
| Review minutes | **UNKNOWN** | Not recorded. `review_latency_h` is latency, not effort. |
| USD | **UNKNOWN** | No dated, sourced price entry exists. `LLM_PRICE_PER_MTOK` has no date or source and is not admitted. |

**Cache share.** Opencode lease totals are about 90 % cache traffic: prompt 11.25 M + completion 1.72 M out of 133.8 M total. The ledger keeps the remainder as `tokens_provider_reported.other` (cache read/write and reasoning, not split until maker token accounting lands).

**Unattributed usage (reported, never spread over the population).** 16.2 M tokens in 8,722 events. Most of it:
- runs of older proposals and runs without a proposal (about 9 M);
- residents and other unlinked server calls;
- unlinked judgments, such as discovery_relevance 2.95 M and commons 2.14 M.

**Usage-event integrity on prod**
- 10,398 events, 10,398 owners.
- Σ over owners = total = 143,381,442.
- 376 shared judgment groups (752 events, split equally at write).

**Mirrors excluded (listed, never counted)**

| Mirror | Rows | Tokens | Owner |
|---|---|---|---|
| maker | 22 | 10,552,279 | the lease |
| jev | 1,360 | 786,579 | the judgment rows |
| transport | 30 | 0 | the caller's own row |
| never sent | 288 | 0 | (not sent) |

**Tool calls.** 6,248 / 6,248 `execution_events` tool.call rows (100 %) link to their lease through the stored `tasks.metadata.lease_id`:

| Role | Calls |
|---|---|
| maker | 4,356 |
| checker | 1,008 |
| security_checker | 884 |

The matrix reported "0 joined" because it joined `execution_events.task_id` directly to `worker_leases.id`. The engine task id has the form `loop-worker-<lease>-<suffix>`.

## The 10.55 M duplicate: ACCOUNTING_CORRECTION, not an operational saving

The duplicate was a counting error, not real spend: no token was saved by removing it.
- **Where it happened.** `resource-ledger.ts` `tokenLedger` summed the maker lease `runtime_usage` **and** the B29 ledger row that `recordMakerCall` writes from that same `runtime_usage`.
- **The fix.** v2 leaves out `consumer = 'maker'`.
- **v1 stays reproducible.** `tokenLedger(..., 1)` still computes it, and `north_star.weeks[].superseded` shows it beside v2.

| Metric | v1 (duplicate counted) | v2 (corrected) | Effect of the correction |
|---|---|---|---|
| Efficiency cloud tokens, 30 d | 146.99 M | 136.44 M | −10.55 M (−7.2 %) |
| North-star week 10-06, cloud tokens | 78.35 M | 67.80 M | −13.5 % |
| North-star week 10-06, verified per M cloud tokens | 0.536 | **0.620** | +0.084 (accounting only) |
| Tokens per verified task (population) | 1.878 M | 1.733 M | −0.145 M |
| Tokens per merged PR (population) | 3.607 M | 3.330 M | −0.277 M |
| Tokens per surviving PR | 68.5 M | 63.3 M | −5.3 M (n = 2) |
| Tokens per valid reviewer verdict | 214 k | 214 k | 0 (the mirror never touches reviewers) |
| Unverified-run token share (population / window) | 55.4 % / 56.0 % | 57.1 % / 57.8 % | +1.7 pp: the duplicate sat mostly on verified runs and **understated** the waste share |
| Reviewer no-verdict spend | 12.90 M | 12.90 M | 0 |
| Matrix headline 3.53 M / merged PR | not affected | not affected | 0 (it used lease tokens only) |

`operational_savings.verified` is empty. No cost-reduction mechanism has a verified effect, and an accounting correction is never listed as one.

## Attribution errors and limits found

1. **Missing tokens.**
   - 272 of 632 non-manual leases have no `runtime_usage.total_tokens`: remote 138 of 139, atomic 16 of 16, opencode cancelled 35, opencode completed-but-unreported 53, opencode failed 30.
   - Their usage is UNKNOWN. Every per-unit value above is a **lower bound**.
2. **The jev ledger under-reports against its judgments.** In the same span, the ledger has 0.79 M input tokens and the judgments have 1.34 M. The ledger rows are treated as mirrors; the judgment rows own the cost. Before this branch, the efficiency view used the ledger's smaller figure.
3. **The server ledger starts on 2026-10-05.** `llm_model_calls` coverage is 0.215 of the window. Panel, frontier_experts and fallback rows mostly carry no tokens or no run link, so most server-side usage is unattributed.
4. **The maker ledger row stores the total as `tokens_in`.** `recordMakerCall` reads `input_tokens`, but the runtime writes `prompt_tokens`. Its output is null although the lease has the split. The ledger reads the split from the lease. The row itself is left as written (never rewrite history).
5. **Proposal status versus run outcome.** The two attribution choices differ by up to 0.7 pp on the waste share; both are reported.
6. **No step-level cost.** Tool calls are fully linked to leases, but carry no tokens or latency, so per-tool cost stays UNKNOWN.
