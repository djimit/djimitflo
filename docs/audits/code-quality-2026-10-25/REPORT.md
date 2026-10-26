# DjimitFlo: three-week engineering and delivery audit

Audit window: **2026-10-04 11:20:24 UTC through 2026-10-25 11:20:24 UTC**, inclusive.
Source baseline: [`6951dba16a32dc8e90971bfe6711033293129eab`](https://github.com/djimit/djimitflo/commit/6951dba16a32dc8e90971bfe6711033293129eab).
GitHub captures were retrieved between 11:23 and 11:37 UTC on October 25; current states may include updates after the window end.

## Assessment

DjimitFlo delivers quickly and has substantial verification infrastructure: Node 22/24 CI, strict required checks, secret scanning, vulnerability scans, mutation testing, pinned actions, a merge train and additive migration conventions. Those capabilities should be extended, not replaced.

The principal constraint is the **trustworthiness of the evidence used to ship and evaluate changes**. The merge train had reproducible concurrency and stale-evidence defects despite its safety claims. Review suggestions were collected but not reliably dispositioned. Several audit PRs publish validators requiring excluded evidence. Evidence and API files change very frequently, increasing collision and interpretation risk. Local passing tests, successful merges and growing proposal counts do not establish sustained operational improvement.

This change repairs bounded defects found during the audit. It does not enable autonomous merges, change production, alter authentication or weaken verification. Further recommendations below require their own implementation and evaluation.

| Review dimension | Assessment of inspected scope |
|---|---|
| Correctness | At risk: reproducible stale-evidence/concurrency failures; bounded repairs tested here. |
| Security | Whole-application security is NOT_RATED. Existing secret/security checks and production boundaries are strengths; they do not certify application security. |
| Performance | Unproven efficiency: CI/run volume is observable, task value, billed compute and energy attribution are not established. |
| Maintainability | Mixed: existing domain boundaries and tests are useful; shared contract churn and undispositioned review evidence impede safe parallel work. |

## Coverage and evidence contract

| Surface | Coverage | What this proves and does not prove |
|---|---|---|
| Main history | All 329 first-parent commits in the window; all 329 reachable commits in the same window; all 2,215 file touches and 1,041 distinct paths inventoried | Every observed main commit maps to a merged PR. This is not independent line-by-line verification of all changes. |
| Pull requests | 417 updated since the window start at capture, paginated back to the cutoff; all changed-file lists retrieved | 329 merged, 74 open, 14 closed at capture. Includes older PRs updated during the window and the small capture lag after its end. Does not include dormant older PRs. |
| Reviews | Review states and threads for all 417; detailed bodies for the 247 with review/thread content | No reported pagination truncation. Top-level discussion bodies were not comprehensively read; counts were captured. Current resolution/outdated state is not the state at merge time; automated findings need validation. |
| Checks | Latest PR-head rollup for all 417; no truncated context list; all observed SHAs match captured PR heads | Current/latest checks are not historical proof of what was green when a merge happened. |
| Actions | 4,417 runs created in the window, paginated in daily partitions with received counts checked | Latest attempt per run ID. Not complete first-attempt results, historical rerun attempts, billed minutes or energy. |
| Failed CI | Step/job metadata for all 92 failed CI runs; selected current-main failure output | Identifies failure stages, not the root cause of every failure. |
| Pushes | 328 main-push CI runs plus reachable main history; 300-event GitHub feed includes 64 push events | Feed reaches only October 22 00:02:31 UTC. **Complete three-week branch push/force-push/deleted-ref history is unavailable.** No complete actor chronology or claim that every push was reviewed. |
| Source | Histories/callers/tests for repaired modules; current CI, package scripts, protection, hotspots and selected lifecycle classifiers | Focused causal review, not a security certification or exhaustive semantic review of all 1,041 paths. |
| Runtime | Isolated worktrees, local temporary Git repositories/SQLite, real local HTTP/WebSocket smoke | No production write, deployment, live database query, fleet measurement or browser-based platform audit in this delivery review. Earlier frontend audit requests are not claimed complete here. |

Distributed inventories: [PRs](pull-request-inventory.csv), [commits](commit-inventory.csv), [all changed paths](changed-path-inventory.csv), [failed main CI](failed-main-ci.csv), [derived statistics](statistics.json).

The `observed_check_state` column is a capture-time signal, not merge approval. The path categories are simple path heuristics; documentation/evidence can contain executable scripts, and application-source paths can contain fixtures. Counts do not measure code quality by themselves.
Git path inventory disables rename detection so both old and new paths are represented for moves; compact rename notation is not counted as a fictional single path.

Raw responses and full logs remain local working evidence. [Their manifest](raw-evidence-manifest.json) records hashes and availability explicitly. They are not included in this pack and hashes do not make them publicly reproducible. The read-only `collect_*.py` scripts and `summarize.py` document collection/derivation; a fresh collection will reflect changed GitHub state. No published validator claims to reproduce withheld evidence.

Run `python3 docs/audits/code-quality-2026-10-25/validate-public.py` to check distributed inventory consistency and code-content binding. Its scope is artifact integrity, not an independent rerun of GitHub collection or test results. Run the actual test commands for independent behavior verification.

## Quantitative findings

| Measure | Observed value | Interpretation |
|---|---:|---|
| Merged PRs | 329 in 21 days | About 15.7/day; throughput, not demonstrated value |
| Median created-to-merged interval | 48.3 minutes | Includes queue/review elapsed time, not active reviewer time |
| Median merged PR size | 190 additions + deletions; 5 files | Typical changes are modest; use source/evidence classification before judging outliers |
| Current open PRs | 74, including 42 drafts | 31 were created more than 14 days before the window end; age alone is not a reason to close them |
| Review submissions | 255 COMMENTED; zero APPROVED submissions in this captured PR population | Automated review participation exists; this does not prove absence of external or operator review |
| Review threads | 468; 457 unresolved; 444 unresolved and not marked outdated | Triage/disposition debt; not 444 independently confirmed current defects |
| Main-push CI | 320 success / 8 failure | 2.44% of these latest-attempt runs failed; not a first-pass failure rate or deployment failure rate |
| PR CI | 729 success / 84 failure / 25 action_required / 1 cancelled / 1 in progress | Permission-required states are separate from failed code |
| All workflow runs | 4,417; 3,406 success, 177 failure, 757 skipped, 75 action_required, 1 cancelled, 1 in progress | Includes CodeQL, dependency automation and scheduled jobs; do not use this as a software test pass rate |

Failed CI job-step occurrences include Test (40), Type check (23), Security audit (22), Scan container image (14), filesystem Trivy (6) and Build container image (5). These are **job-step counts**, including matrix jobs; they are not mutually exclusive run counts. Security advisories and base images can change between PR and main checks. The eight red main runs alone do not prove branch protection was bypassed.

**Positive timing evidence:** all 329 captured merged PR heads have successful check entries for the five currently required contexts, with completion timestamps before their recorded merge times. This supports use of the check path; it does not reconstruct historical protection settings, reviewer independence or deployment approval.

**Post-merge gap:** one of the 329 main commits has no indexed main-push CI run in the collected window: [#912](https://github.com/djimit/djimitflo/pull/912), `6c3e507bda0fe900e885f85b8169915812289b5b`. An additional SHA-filtered Actions query returned zero runs of any kind. Its captured PR checks are green and predate merge. Event suppression, deletion, token identity or another cause is **unverified**; do not infer an authorization bypass. Add SHA-to-post-merge-result reconciliation to existing delivery evidence and investigate absent runs before treating every merged artifact as integration-tested. No rerun was triggered by this audit.

### Churn and coupling

| Path | Main commits touching it |
|---|---:|
| `packages/server/src/services/evolution-evidence.ts` | 88 |
| `docs/runbooks/self-improvement-loop-operations.md` | 84 |
| `packages/dashboard/src/lib/api.ts` | 83 |
| `packages/server/src/__tests__/evolution-evidence.test.ts` | 49 |
| `packages/shared/src/contracts/operator.ts` | 44 |
| `packages/server/src/services/loop-daemon.ts` | 26 |
| `packages/server/src/database/migrate.ts` | 24 |

**Observed:** evidence contracts and API plumbing recur across independent features. **Inferred:** parallel work repeatedly converges on shared files, increasing review/context and rebase costs. Churn is not proof these modules need splitting. First identify genuinely repeated mapping/registration logic, then extract only that repeated responsibility into existing domain modules. Keep one API contract and one effective flag inventory.

Large diffs need interpretation: [#966](https://github.com/djimit/djimitflo/pull/966) adds 71,473 lines across 13 files, largely research/evaluation artifacts; [#840](https://github.com/djimit/djimitflo/pull/840) is a 20,581-line retirement diff across 69 files; [#939](https://github.com/djimit/djimitflo/pull/939) has 57 files. A line-count cap would treat these unlike changes as equivalent. Separate executable changes from generated/raw evidence, keep concise manifests and enough sanitized evidence to validate distributed claims.

## Validated defects repaired here

### D1 — P0: reconstructed branch can overwrite a concurrent push

**Verified:** `scripts/merge-train.sh` reconstructed a published branch and used unconditional `git push -f`. A second writer can publish between reconstruction and push. A real temporary bare-remote regression fails on unchanged main: the peer head is overwritten. No production incident is asserted.

**Correction:** use `--force-with-lease=refs/heads/<branch>:<original-head>` and an explicit branch refspec. Record push intent before acting and supersession only after reported success. On unconfirmed/refused push, restore the local branch and fail closed. A transport failure can happen after remote acceptance; the message requires live remote inspection before retry.

**Files/tests:** `scripts/merge-train.sh`, `merge-train.test.ts`, `docs/runbooks/merge-train.md`. Real Git tests cover concurrent rejection and unchanged-remote success. Alternative: refuse all branch reconstruction and require manual work; higher operator friction without improving the tested race protection. Complexity S; no service/schema dependency. Risk: previously unpublished/stale branches now refuse instead of being overwritten; documented deliberate constraint. Acceptance: peer commit preserved, local head restored, no false superseded completion.

### D2 — P1: stale or incomplete evidence can drive the merge train

**Verified:** older [#807 review findings](https://github.com/djimit/djimitflo/pull/807) remain applicable. The train ignored failed main refreshes, accepted a branch-update response without observing a new head, and downloaded a PR diff before binding it to a head. A partial download with nonzero exit could still produce a usable patch. Six new regression cases fail on unchanged main.

**Correction:** read head before diff download; compare to live head before processing it; reject failed downloads even when they contain valid hunks. Failed main refreshes at initial, pre-merge and post-merge stages HOLD. An accepted update without observed head transition HOLDs rather than reusing old CI. Preserve exact-head merge checks, policy, claims and recovery behavior.

**Files/tests:** merge-train script and both merge-train suites. Alternative: require only explicit PR@SHA arguments; useful operational convention but does not solve ignored refresh failures or update completion. Complexity S/M; no new infrastructure. Risk: more honest HOLDs during transient GitHub/network failures. Post-merge HOLD can mean merge already happened; inspect/retry through existing live-state recovery. Acceptance: no mutation on stale diff/pre-merge refresh failure; no verified completion on failed post-merge refresh; no checks of old SHA after an unpublished update.

The original legacy test stubs said “updated” without changing a head. They now explicitly model “up-to-date”; the separate accepted-but-unpublished regression preserves the asynchronous failure case. Tests were corrected to model the contract, not relaxed to permit stale evidence.

### D3 — P1: unavailable reflection quota count becomes measured zero

**Verified:** [#997](https://github.com/djimit/djimitflo/pull/997)'s review identified `createdInWindow = 0` surviving a query exception. The resulting runtime-failure decision could be persisted with a fabricated zero.

**Correction:** initialize unknown count to `null`; keep the interface nullable until the quota query succeeds. Existing downstream disposition types already accept null. Proposal admission/cap policy remains unchanged.

**Files/tests:** `self-improvement-service.ts`, `reflection-proposal-disposition.test.ts`; existing service suite also exercised. In-memory missing-table regression fails before and passes after. Complexity XS; no migration. Risk: consumers outside the repository that assumed a number must accept null; in-repository callers type-check. Acceptance: query failure produces `runtime_failure`, null count and no proposal; successful measured zero stays zero.

### D4 — P1: active runtime process-group flag invisible in evolution evidence

**Verified:** [#1002](https://github.com/djimit/djimitflo/pull/1002) adds an existing default-off runtime lifecycle flag and runbook row, but not its `EVOLUTION_FLAGS` entry. Evolution snapshots cannot report activation. Existing drift test checks registry → runbook, not all flags in reverse.

**Correction:** register `RUNTIME_PROCESS_GROUP_KILL` as acting, with snapshot regression. No flag is enabled and runtime termination behavior is unchanged. Complexity XS; existing flag/runbook are dependencies. Risk low. Acceptance: environment value `on` appears in the snapshot with `acting: true`; drift test remains green.

These are correctness/visibility repairs, not new autonomous capabilities. No additional rollout subsystem or flags were added for the repairs themselves.

### D5 — P1: calendar-dependent fixtures started failing during verification

**Verified after the audit window:** the initial PR's Node 24 [CI run](https://github.com/djimit/djimitflo/actions/runs/40191121973) failed existing TG-001 and value-allocator tests. Both independently reproduce on unchanged baseline after **2026-10-25 12:00 UTC**: TG-001 seeds a rule at October 11 noon but asks the real wall clock for a 14-day freshness cutoff; the allocation endpoint seeds a judgment at October 18 noon but aggregates the real seven-day window. The assertions were correct for the intended fixture date and became false as the calendar advanced. This is distinct from the earlier smoke startup timeout.

**Correction:** pin Date in these two test suites to their existing fixture reference dates, leaving timeout/I/O timers real and restoring Date afterward. Existing assertions now pass: **34 related tests**, after two failures on unchanged main. No production freshness rule, prompt, frozen experimental implementation or selection criterion changes. Complexity XS; Vitest already provides the clock. Risk: Date-only mocking must be restored and must not accidentally fake HTTP timers; related suites and full CI verify this. Acceptance: meaningful assertions remain unchanged and fixtures stay inside their intended reporting/freshness windows on later calendar dates.

Main advanced to test-only [#1005](https://github.com/djimit/djimitflo/pull/1005) while this PR was prepared. That change was integrated into the topic branch, its 14 tests passed, and the PR's final-head CI is separate from the historical audit capture.

## Important unresolved findings and implementation backlog

Every item below is a separate implementable follow-up. Effort: XS < half day, S about a day, M several days; estimates are planning assumptions. Proposed benefits are targets, not measured gains.

| ID / priority | Evidence and root-cause confidence | Intervention / affected modules | Alternative, dependencies and risk | Acceptance / measurement |
|---|---|---|---|---|
| B1 P1: diagnose intermittent startup smoke failure | **Observed** latest main [run 40178084563](https://github.com/djimit/djimitflo/actions/runs/40178084563), Node 22 job 121123028827, times out waiting for health at `e2e-smoke.test.ts:57`. Unchanged local focused test passes in 14.45s. Root cause **unverified**. | S: drain child stdout/stderr into a bounded diagnostic buffer, report spawn/early exit and last readiness error, then reproduce under Linux CI contention. Inspect fixed-port allocation and subprocess cleanup. | Do not merely extend the already 180s timeout or quarantine the spine test. Dependencies: test harness, actual Linux reproduction. Log redaction needed; no credential/environment dumps. | Forced child-exit and startup-delay scenarios yield useful bounded diagnostics; repeated identical Linux runs establish failure rate. Fix actual cause before claiming resolved. |
| B2 P1: review findings have no dependable closure signal | **Observed** 444 unresolved/not-outdated threads, 423 on merged PRs; several #807 findings independently reproduced here. Root cause partly process/UI; unresolved does not imply unfixed. | M: use existing PR threads and exact-head evidence to record fixed / superseded / false positive / accepted risk with reason and verification link. Extend existing merge-train plan to surface undispositioned material findings without treating every bot comment as a veto. | Avoid blanket “resolve all” or a new approval bureaucracy. Depend on reviewer identity and current source revalidation; maker cannot independently check itself. Test missing/stale/wrong-head dispositions and bot false positives. | Sample high-risk current threads first; track validated escaped defects and time to disposition, not resolved-comment count. Target zero unexamined validated P0/P1 findings at operator merge decision. |
| B3 P1: audit publication cannot reproduce its PASS | **Verified source/file-list mismatch** for #1004 and #991 at captured heads: validators read required `.log` files, none distributed; #1004 uses `/private/tmp/djimitflo-swarm-audit-src`. See `audit-pack-inspection.json`. Other packs need separate validation. | S: fix those existing pack validators, include sanitized minimal evidence or mark withheld checks NOT_TESTABLE; make source root supplied/relative, bind to source SHA. Correct committed validation record. | Do not publish raw operational screenshots/logs blindly. Alternative is a concise report with explicit unavailable evidence. No new evidence platform required. | A clean checkout validates exactly the published subset without private paths; withholding produces explicit partial coverage, never fabricated full PASS. |
| B4 P1: Commons outcome can turn unknown gates into substantive rejection | **Source-supported hypothesis**, #994 review and current `commons-investigation.ts` failure classifier; no independent regression executed here. | S: recognize structured insufficient-evidence block reason/unknown gates before text classification; retain unknown outcome. Add local DB tests for unknown-only, genuine failed gate and recovered verification. | Extend current milestone classifier; do not alter protected verification gate. Dependency: verification payload contract. Risk: historical aggregate movement. | Unknown-only run never counted as substantive failure; genuine failure remains visible; reconcile old/new cohorts in shadow before adoption. |
| B5 P1: Commons lifecycle starvation/readiness bias | **Source-supported hypotheses**, #994 oldest bounded sweep, #993 global 200-failure bound and lost lease lapse timestamp. | M: test >200 origins and many-agent histories; paginate existing sweep fairly; select latest failure per agent by failure event time before limiting. Preserve actual lapse provenance or mark order unknown. `commons-investigation.ts`, `agent-communication-service.ts` and suites. | Existing schema/cursor first; no new queue. Dependencies: event timestamp semantics, cleanup compatibility. Risks: query cost and old-client interpretation. | Later origins receive updates within bounded sweep cycles; a noisy agent cannot hide another's failure; TTL expiry cannot move an old failure after a successful reply. Measure sweep coverage/age and readiness error rate. |
| B6 P1: historical panel failure can mask recovery | **Source-supported hypothesis**, #992 and current `honest-numbers.ts:194` checks historical `panel_failed` before substantive current outcome. | S: prefer completed current panel evidence over earlier retry markers where lineage proves recovery; keep unresolved infrastructure failures distinct. Tests for fail→retry→blocked/backlog/goal and failed latest attempt. | Do not delete audit history. Dependencies: panel/run identity, actual retry semantics. Risk: relabeled historical counts; publish contract change. | Recovered panel classified by current evidence, no permanent technical-failure label from an earlier attempt. Cohort replay reconciles all changed counts. |
| B7 P2: rollout inventory completeness | **Verified** D4; #992/#993/#997 reviews also dispute absent default-off controls for instrumentation/UI changes. Policy interpretation for those features needs owner decision, not blind flag proliferation. | S/M: inventory effective behavior-changing flags at existing config/EVOLUTION_FLAGS/runbook boundaries; add reverse/completeness checks with an explicit list for documented non-rollout settings. | Avoid regex that treats every environment read as a rollout flag, and avoid another registry. Preserve current default-off new-capability rule. | Each lifecycle-changing flag has source/default/modes/effective snapshot/runbook and a focused off/shadow test; unknown configuration is explicit. |
| B8 P2: fast local test command omits workspaces | **Verified configuration:** root `test:changed` enumerates server/shared/catalog/MCP only; dashboard, Telegram and ransomware module omitted. Full CI **does** run their suites. | XS: route changed tests through all supporting workspaces using existing npm workspace mechanism. Check related builds/working-tree base semantics. | Keep full CI. Avoid implementation-mirroring string tests; exercise a changed dashboard test and a server test in a disposable worktree. | A failing changed test in each supported workspace makes the command fail; unchanged workspaces do not run the whole suite unexpectedly. Measure feedback latency. |
| B9 P2: CI resource usage lacks cost attribution | **Observed** 4,417 runs, 1,168 CI, 1,168 secret scan; no workflow concurrency cancellation in reviewed CI. Only one cancelled run. **Unverified** billed minutes/energy waste. | M: measure elapsed job time, queue time and superseded-head overlap first. Then cancel obsolete PR-head work by PR concurrency group; preserve main/deploy jobs and all latest-head required checks. Review repeated builds before adding caches. | Protected workflow change needs explicit scoped proposal. Alternative: batch pushes locally and use focused tests first. Never skip required security checks for speed. | No obsolete-head merge; latest PR head receives every required check; compare runner-minutes and p95 feedback on matched PR cohorts, target ≥20% reduction with unchanged defect escape. |
| B10 P2: patch dependency debt without duplicate PRs | **Observed fresh `npm ci` audit:** 4 moderate findings, zero high/critical; Vitest/mocker, Hono and fast-uri affected. Open dependency PRs already overlap. | S: update existing dependency PRs one ecosystem at a time, pin lockfile and run exact-head CI/security checks. No `npm audit fix --force`. | Advisory state changes; audit captured Oct25 is not permanent. Need current advisory paths and compatibility tests. Risk: toolchain behavior drift. | Current lockfile has no actionable moderate findings or an explicit reviewed exception; no duplicated competing patch PRs; type/lint/test/security all pass. |
| B11 P2: shared-file coupling / review load | **Observed** hotspot counts above; architectural cause **inferred**. | M: map two or three recurring domain registrations to existing modules; remove repeated plumbing only where contracts/tests show repetition. Keep small vertical PRs with contract/consumer tests. | Do not split a file just because it is large or add another service. Dependency: concrete repeated responsibility. Risk: import cycles/contract drift. | Paired sample shows fewer shared-file conflicts and review iterations without more coordination layers. Reject extraction if it does not reduce change surface. |
| B12 P2: PR portfolio carries stale/overlapping work | **Observed** 74 open, 42 draft, 31 older than 14 days. State/CI per PR in inventory. | S: operator-led triage by intent, exact SHA, supersession and dependencies; revalidate before resuming. Preserve unmerged research/evidence. Reuse existing labels and merge train. | No automatic age-based close/merge, no force push to other agents' branches. Risk: accidental loss of unique work if closure is inferred from similar titles. | Every resumed PR has current intent, unique diff, owner and acceptance evidence; count duplicate work avoided and oldest actionable PR age. |

### Current protection and appropriate changes

Observed branch protection requires `build-and-test (22)`, `build-and-test (24)`, `security-scan`, `sbom`, `gitleaks`, strict up-to-date checking and administrator enforcement. Main force pushes and deletion are disabled. Required approving-review count is zero; conversation resolution is not required. Mutation, fleet-auth and CodeQL jobs are not all mandatory branch contexts.

Do not add blanket human approvals or conversation-resolution gates simply to make the numbers look safer. Preserve the operator/exact-head merge boundary and separate independent checking from making. First disposition validated high-risk findings and repair the proven merge-train gaps. Assess which additional existing checks should be required against actual escaped defects, runtime and false-positive rates. Current protection is a snapshot, not a reconstruction of every historical merge's rules.

## Make evolution improve software rather than generate more work

Keep the existing proposal → review → execution → verification → survival route. Link each engineering candidate to a reproduced failure or operator task, a baseline, exact code/model/policy/task versions, a verification result and subsequent survival. “Registered”, “tests passed”, “merged” and “sustained improvement” are separate states.

Use existing judgments, run IDs, goals and PR/SHA identities. No new registry or database is justified by this audit. A reflection is a candidate, not a fitness reward. A test-only change can be valuable if it kills a real mutation or detects an escaped defect; counting tests added or PRs merged encourages low-value work. A smaller swarm is preferable when comparable task success is maintained with less resource use.

Proposed primary measures:

- Sustained independently verified operator outcomes at 7/14/30 days, with cohort/denominator and unavailable evidence explicit.
- Escaped validated defects per shipped change, recovery time and recurrence by root cause; separate security-advisory drift from application regressions.
- Total tokens, wall time, runner minutes and **joules or Wh** per successful held-out task, including maker, checker, retries and verification. Watts measure power, not total energy. Provider energy is UNKNOWN unless measured or explicitly modeled with uncertainty.
- Review iterations and stale-head/rebase failures per accepted change. Do not reward resolving comments without evidence or reducing tests.

### Controlled comparisons

| Experiment | Design and confounders | Promotion / stopping rule |
|---|---|---|
| Merge-train correctness | Deterministic paired isolated fixtures: same repos and probe histories, original vs repaired script. Include concurrent writer, failed download, stale fetch, delayed head, successful publication and retry recovery. | Already demonstrates the repaired boundary behavior locally. Promotion still requires independent exact-head review and green CI; any overwritten peer head or stale-evidence mutation rejects. |
| Better defect-driven task selection | Use existing task miner and frozen held-out tasks. Compare current candidate selection with candidates linked to independently reproduced defects, at equal total token/time budget. Balance task family, model, runtime and initial failure severity. Start with 30 paired tasks to estimate variance, then set sample size/power and minimum useful effect before a confirmatory run. | Require task success noninferiority plus lower cost per surviving fix, confidence interval excluding the predeclared unacceptable regression; do not promote on point estimate alone. Stop for safety-boundary failure. |
| Swarm vs single capable agent | Same held-out tasks, tool/model availability, context and checker; count coordination, retries and verification cost in both arms. Randomize order, freeze versions and prevent sharing candidate solutions into control memory. | Adopt swarms by task family only where quality improves enough to justify resource use, or equivalent quality uses less total resource. No claim of universal swarm superiority. |
| Memory / skill reuse | Paired tasks with retrieval/reuse enabled vs ablated, immutable memory snapshot, no evaluator leakage; record retrieved evidence and obsolete/conflicting examples. | Promote only for reproducible quality/latency/resource gains without contamination or held-out regression. Stored memory and skill registration are not learning evidence. |
| CI efficiency | Matched PR cohorts before/after obsolete-head cancellation; report job minutes, p95 latest-head result time and escaped defects. Control dependency updates, PR size and runner contention. | Keep every latest-head required check; any loss of exact-head assurance rejects. A cost-reduction target is a hypothesis until measured. |

## Implementation sequence

1. Independently review this patch and its exact-head CI; operator merges through the existing train only after satisfied. No autonomous merge or deployment was performed by this audit.
2. Diagnose the current main smoke failure and finish material review dispositions. Repair the distributed audit packs before relying on their PASS claims.
3. Add lifecycle edge-case regressions for Commons unknown/recovery/starvation before changing metrics. Review rollout defaults and consumers together.
4. Close the focused-test workspace gap; update existing dependency PRs and triage redundant/stale work by intent.
5. Measure CI and swarm economics, then run controlled comparisons. Consolidate repeated contract plumbing only when a concrete change-surface reduction is demonstrated.

## Verification record and limitations

Local failing-first evidence: one concurrent-push regression, six evidence-binding/refresh regressions and two telemetry/flag regressions fail against the unchanged baseline. Positive publication control also exercised. Related merge-train suites pass **47 tests**; evidence/reflective proposal/runbook suites pass **66 tests**. Local type-check, lint, build, complete root test, Python poller tests and audit gate were run; see [verification](verification.json) for the final command outcomes and [sanitized test evidence](verification-evidence.txt). Lint has one pre-existing unused-disable warning, no errors.

GitHub CI for this PR is separate from these local results and must be checked on the exact final head. No browser/production capability status, sustained evolutionary gain, token saving, watt saving or complete push chronology is established by this audit. No claim is made that all unresolved review findings were fixed, every open PR is safe to merge, or every changed line was semantically verified.
