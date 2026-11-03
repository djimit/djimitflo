# JEV capability forensics — DJIMIT-JEV-EVOLUTION-L3-001 (deliverable A)

Status: **DRAFT, read-only forensics.** No deploy, merge, flag change, new jev call or new LLM call was made for this
document. Prod was read through `docker exec … node` with `better-sqlite3` `{ readonly: true }` on
`/data/djimitflo.sqlite`; nothing was written. Missing evidence is written **UNKNOWN**, never 0.

Snapshot: 2026-10-22 ~19:50 UTC. Prod build `5dfc6cdb` (`/health`: `commit_matches_build: true`, `build_source:
deploy-vps.sh`, built 2026-10-22T03:41Z) = `origin/main` at the time of writing, so every `file:line` below is the code
that runs in prod.

Binding rules this document is read against (operator 11-10, NE-001, `JEV-114_PROTOCOL.md`, plan L361): jev is the only
System One backend; jev only for narrow, objectively verifiable, text-grounded judgments with ground truth; **never** for
approval, promotion, code, risk or fitness decisions. D5-NO, JEV-114, ACE-001, STE-001, MAKER-DEPS-001, F2 v2, memory
holdout and genome trials are running and are only *read* here.

## 1. Answer first

1. **Verified jev value today is narrow and mostly offline.** The only jev capabilities with ground truth and a good
   score are (a) `names_file` vs the deterministic `PATH_RE` label — ECE 0.079, AUROC 0.959, n = 196 (JC-001 §3) — and
   (b) the IMG-001 "error shown?" Noul on 34 dashboard screenshots — 34/34, Brier 0.001 (plan L1538-1541, offline,
   jev-1.14.0). (a) re-derives a label that code already computes exactly (`namedPathsExist`,
   `judgments/proposal-prescreen.ts:33-38`), so its marginal value over code is zero by construction.
2. **One jev judgment acts in prod today and it is unverified:** `kb_passage_relevance` (enforce) drops 88 of 452
   (19.5 %) KB passages from panel prompts. It has no relevance labels and no link to panel outcome. The value allocator
   classes it `VALUE_PROVEN` only because "a gate read it" (`decision_consumed` 170, `verified` 0) — a definitional
   artefact, not an outcome.
3. **The proposal pre-screen never acted.** The D5 enforce window (10-09 13:08 → 10-12) wrote 21 enforce rows, all `yes`;
   `prescreen_park` rows ever: **0**. NE-001 rejected the cascade (holdout risk 0.20 [0.07, 0.45]). D5-NO (running, not
   touched) has accrued **0** confident-NO clusters since its 10-11 cutoff (84 post-cutoff proposals pre-screened, all
   `yes`) — reported as accrual only; no outcome of its population was analysed.
4. **Two shadow jev paths act or would act through side doors:** `discovery_relevance` decides expert-unit creation and
   overrides the keyword gate under `FRONTIER_UNITS_REQUIRE_RELEVANCE=true` (prod) while its rows say `mode='shadow'`; the
   code itself calls unit creation "a promotion" (`expert-source-units-service.ts:123, :143`). It is paused (#825) — the
   pause stays. `commons_contribution` rows are read by `threadGated` (`agent-social-autopilot-service.ts:387-397`,
   `COMMONS_THREAD_GATE_ENABLED=true`) although the judgment itself has been `off` since 09-30.
5. **Two integrations sit in forbidden domains:** `checker_second_opinion` (code review; 650 k tokens / 30 d) and
   `risk_atomic` (risk; 213 of 216 non-error rows `jev=low kw=low test_only`, zero discriminating information). Both are
   shadow with no consumer (`NO_CONSUMER` in the allocator). JC-001 §4 already marked both "REJECT by policy".
6. **Cost is UNKNOWN in money.** All 2 543 jev ledger rows have `list_price_cost` and `marginal_cost` NULL; `tokens_in`
   is `ceil(body.length / 4)` (`typesafe-client.ts:106`), `tokens_out` 0. Estimated input over 30 d ≈ 2.4 M tokens
   (allocator, judgment rows). Latency is good: primary p50 234 ms / p95 1 855 ms (n = 677, since 10-12).

## 2. jev integrations: inventory and six-level status

Prod: `vps-agentical`, container `djimitflo-live`, build `5dfc6cdb` (= origin/main at the time of writing, `/health`
`commit_matches_build: true`, built 2026-10-22T03:41Z). Every number below is from read-only queries on
`/data/djimitflo.sqlite` (`readonly: true`) at 2026-10-22 ~19:50 UTC, unless a file is cited. Flag values are the container
env (`docker exec … process.env`, key allowlist, no secret printed).

Client: `packages/server/src/services/typesafe-client.ts` — pinned `TYPESAFE_MODEL` default `jev-1.13.0` (:62); limiter
6 in flight / 1 000 queue (:46-59, #679 + JEV-BURST); breaker 3 failures → 60 s (:15-17, :118); one ledger row per call
(:83-84 → `llm_model_calls`, consumer `jev`, provider `typesafe`); `prepareState` redacts secrets and caps 60 k chars (:19-31).
Orchestration: `judgment-service.ts` `runJudgment` (:82-116), `runJudgments` (:123-160), `decideObserved` (E2, #794; :49-58),
`fireChallenger` (JEV-114; :187-220), `localShadow` (T1; :229-239). Mode per judgment = env `TYPESAFE_<ID>_MODE`
(off|shadow|enforce, default off; :25-28).

Status levels: **L1** implemented · **L2** enabled in prod · **L3** invoked in the last 7 days · **L4** producing decisions
(a code path acts on the verdict) · **L5** producing verified outcomes (verdict linked to an outcome with ground truth) ·
**L6** demonstrably improving outcomes (a pre-registered or paired comparison shows a gain).

| # | Judgment (policy v) | Call site | Prod mode | Rows (first → last) | L1 | L2 | L3 | L4 | L5 | L6 |
|---|---|---|---|---|---|---|---|---|---|---|
| J1 | `proposal_prescreen` (1) | `self-improvement-auto-review-scheduler.ts:150` (act: :161-164 → `parkByPrescreen`, `self-improvement-service.ts:248-257`) | shadow (frozen by D5-NO) | 332 (09-21 → 10-22); enforce rows 21 (10-09 → 10-12) | yes | yes | yes | **no** — enforce window produced 21 × `yes`, 0 parks (`prescreen_park` rows ever: **0**) | partial — outcome = `self_improvements.status`; operator labels on 56 `no` rows | **no** — NE-001 REJECT (#779) |
| J2 | `checker_second_opinion` (1) | `loop-worker-executor-service.ts:716-727` | shadow | 203 (09-23 → 10-22) | yes | yes | yes | no | partial — run outcome via `worker_leases → loop_runs` (202/203 linked); run status is not correctness ground truth | no |
| J3 | `reflection_triage` (1) | `self-improvement-service.ts:344` | shadow | 169 (09-23 → **09-30**) | yes | yes | **no** (no `needs_grounding` proposal since 09-30) | no (`NEEDS_GROUNDING_TRIAGE_ENABLED` unset → off) | no — all 169 subjects `archived` (no outcome variance) | no |
| J4 | `failure_cause` (1) | `dream-state-service.ts:137` | shadow | 274 (09-23 → 10-22) | yes | yes | yes | learner only (`consolidate`, :149+; `LEARNER_READ_JUDGMENTS`, `value-allocator.ts`) | no ground truth in DB (UNKNOWN whether DI-001 MAKER_FAILURES labels map onto these rows) | no |
| J5 | `commons_contribution` (1) | `agent-social-autopilot-service.ts:350` | **off** | 1 368 (09-23 → **09-30**) | yes | no | no | dormant gate: `threadGated` (:387-397) reads these rows with `COMMONS_THREAD_GATE_ENABLED=true`, but no new rows since 09-30 | no | no |
| J6 | `commons_idea` (1) | `agent-social-autopilot-service.ts:340, :350` | **off** | 1 327 (09-23 → 09-30) | yes | no | no | no (consumer: none, `effort-controller.ts:152`) | no | no |
| J7 | `discovery_relevance` (1) | `expert-source-units-service.ts:118, :140, :155, :303` | shadow **but acting** (`FRONTIER_UNITS_REQUIRE_RELEVANCE=true`); **paused** (`DISCOVERY_RELEVANCE_PAUSED=true`, #825) | 3 930 (09-26 → **10-14**); backlog 1 638 `unjudged` | yes | yes (paused) | **no** (paused since 10-14/15) | **yes until the pause** — unit creation and keyword-gate override (:120-127, :141-147, :306-313) | partial — DI-001 relevance has 7 offline labels (INSUFFICIENT); **0** blind labels in prod since the #835 UI went live | no |
| J8 | `risk_atomic` (1) | `autonomy-shadow-service.ts:33` | shadow | 218 (10-02 → 10-22) | yes | yes | yes | no (consumer: none) | no — 213/216 non-error rows `jev=low kw=low test_only`; no labelled risk outcome | no |
| J9 | `decision_context` (1) | `decision-context-service.ts:67` ← `self-improvement-agent-review-service.ts:247` | shadow | 276 (09-23 → 10-22) | yes | yes | yes | no (enforce would inject memories) | no labels | no |
| J10 | `kb_passage_relevance` (1) | `kb-corpus.ts:98-112` (`gatePassages`) ← `kbContext` | **enforce** | 170 (09-29 → 10-22) | yes | yes | yes | **yes** — 88 of 452 page verdicts (19.5 %) < 0.5 dropped from the panel prompt | no — no relevance labels, no panel-outcome linkage | no |
| J11 | JEV-114 challenger `<j>@jev-1.14.0` | `judgment-service.ts:187-220` | `JEV_CHALLENGER_MODEL=jev-1.14.0`, sample 0.2 (default) | 43 rows (10-16 → 10-22) | yes | yes | yes | no (no decision reads `@` rows, :168-170) | in progress (registered experiment, stop_by 2027-01-14) | n/a (running) |
| J12 | T1 local shadow `<j>@local` | `judgment-service.ts:229-239`, `local-shadow-queue.ts`, `scripts/local-systemone.mjs` | **off** (`TYPESAFE_LOCAL_SHADOW_ENABLED=false`) | 324 rows (09-28 → 09-30) | yes | no | no | no | no | no |
| J13 | `forecast:jev_calibrated` (code forecaster on jev prescreen answers) | `forecasters.ts:50` ← scheduler `:155` | shadow (`ARENA_FORECASTS_ENABLED=true`) | 200 (10-02 → 10-22) | yes | yes | yes | no | yes — scored vs `self_improvements.status` | **no** (see §4.2) |
| J14 | `effort_decision` (EVC hook (c) on every judgment dispatch) | `judgment-service.ts:86, :126` → `effort-controller.ts:162-176` | shadow (`EFFORT_CONTROLLER_MODE=shadow`) | 1 197 (10-09 → 10-22): run 1 018 / skip 179 | yes | yes | yes | no | no | no |

Not jev (often confused with it): `content_safety` / `content_safety_prompt_gate` (NVIDIA nemotron-3.5-content-safety,
`content-safety.ts`; 6 096 rows, mode shadow except KB ingest which acts in every mode); `kb_retrieval` (embedding cosine);
`proposal_near_duplicate` (embedding); `panel_*`, `forecast:committee*`, `forecast:resident*` (LLM residents);
`auto_approve_shadow`, `artifact_integrity`, `operator_label`, `requeue*`, `telegram_access` (code / human).

**Summary of the six levels.** 10 jev judgments implemented; 8 enabled (2 off); 6 invoked in the last 7 days (prescreen,
checker opinion, failure cause, risk atomic, decision context, KB passage relevance); **1 producing decisions today**
(`kb_passage_relevance`, enforce, unlabelled); 1 that produced decisions until the 10-14 pause (`discovery_relevance` via
`FRONTIER_UNITS_REQUIRE_RELEVANCE`); **0 with a demonstrated improvement in outcomes**.

## 3. Decision lifecycle per jev integration

Common path (all J1–J10): `judgmentMode` (judgment-service.ts:25-28) → `typesafeConfigured` (:85) → `recordEffortJudgment`
(:86, EVC shadow) → state hash `sha256(JSON.stringify(state))[0:16]` (:88) → `client.systemOne` (:92; shadow = 0 retries,
enforce = 2) → `decideObserved` (:93; E2/#794: any invalid answer ⇒ `uncertain`, never a default `yes`/`no`) → `localShadow`
(:94) → `buildProvenance` (:96) → one transaction: `insertJudgmentRow` + optional `commit` hook (:99-103; DI-001 C) →
`fireChallenger` (:104). Errors: an `error` row with provenance status `error` (:108-113); the caller gets `null` and keeps
its own logic (fail-open).

Identity and reproducibility fields recorded per row (`judgment-provenance.ts:18-32, :76-112`): `policy_id`,
`policy_version` (all `'1'`), `prompt_id`, `prompt_version` = sha256 of the questions **and** the `decide()` source (:60-62),
`input_digest` = canonical sha256 of the redacted state (:58), `model_id` / `model_version`, `evaluator_version`
(`decideObserved/v1`), `execution_mode`, `decision_timestamp`, `evidence_reference`. Not recorded: request hash as sent,
raw response hash, endpoint, sampling parameters (jev exposes none). `hasMandatoryProvenance` (:133-139) gates every
promotion-like use. Coverage in prod: provenance only on rows written since **2026-10-14** (prescreen 70/332, checker 57/203,
discovery 185/3 930, failure cause 70/274, risk 83/218, decision context 47/276, KB passage 52/170; commons_* and
reflection_triage 0 — they stopped before 10-14).

| Judgment | Decision identity | Policy version | Persistence idempotency | Race protection | Crash recovery | Reproducibility | Outcome link |
|---|---|---|---|---|---|---|---|
| J1 prescreen | `(self_improvement id, state_hash)`; new row each tick while the proposal stays `proposed` (scheduler.ts:146-150) | `'1'` + prompt_version hash | **none** on the judgment row: 22 subjects carry 70 rows with identical `(subject, state_hash)`; the park itself is a CAS (`WHERE status='proposed'`, service.ts:251) in one transaction with its audit row | in-process `this.running` flag (scheduler.ts:139-140, :212); park CAS | none needed in shadow (next tick re-judges); enforce park is atomic | prompt_version + input_digest since 10-14; pinned model `jev-1.13.0` | `self_improvements.status` by `subject_id`; `forecast:*` rows; D5-NO clusters (`d5-no.ts`) |
| J2 checker opinion | `(worker_lease checker id, state_hash)`; facts `checkerVerdict`, `loopRunId` are **not** persisted except inside `reason` | `'1'` | one call per checker lease (no dedupe needed; 0 duplicate groups) | n/a (awaited inside try/catch, never gates) | lost on crash (shadow) | as J1; diff truncated to 24 k chars (`checker-second-opinion.ts:11`) | `worker_leases.loop_run_id → loop_runs.status` (`honest-numbers.ts` oracleAgreement); merge survival not joined |
| J3 reflection triage | `(self_improvement id, state_hash)` | `'1'` | fire-and-forget at insert; one per proposal | n/a | lost on crash | no provenance (all rows pre-10-14) | `self_improvements.status` (all `archived`) |
| J4 failure cause | `(loop_run id, state_hash)` | `'1'` | retried once when `uncertain` (`dream-state-service.ts:96-97`) — **72 subjects re-judged on an identical state_hash** (144 rows): a deterministic model on the same state cannot change its answer | dream scheduler single-flight (UNKNOWN beyond scheduler) | next replay picks it up | as J1 | none to ground truth; consolidation → `memory_candidates` (`source_ref dream:cause:*`) |
| J5/J6 commons | `(agent_message id, state_hash)`; `runJudgments` shares one call (R1) | `'1'` | one per reply | n/a | lost | no provenance | none |
| J7 discovery relevance | `ref` (subject re-pointed to the unit afterwards); backlog key `(event_id, policy)` with `fence` (migrate.ts:1406) | `'1'` | ingest: "judged once" check (`expert-source-units-service.ts:139`); backlog: fenced claim + commit-hook veto (:270-313, judgment-service.ts:99-103); 9 duplicate groups remain from pre-backlog era | **fenced CAS** on the backlog (best of all jev paths) | stale `rejudging` claims re-opened after a timeout (:270-272); failed after `max_attempts` | as J1 — **but** `UPDATE judgments SET subject_type='expert_unit', subject_id=…` (:146, :178, :310) rewrites the row's identity after the fact, while `provenance_json.evidence_reference` keeps the original subject | blind operator labels (#835, `operator_label` rows, `discovery-relevance-labels.ts:222-223`); unit consumers (committee, dream-evolution, interest-feedback) |
| J8 risk atomic | `(approval id, state_hash)` | `'1'` | once per approval wait: `autonomy-shadow-service.ts:22` returns early when an `auto_approve_shadow` row exists, and the jev call sits behind that check (:31-35) — 0 duplicate groups observed | n/a | lost | as J1 | `approvals.status` (all `approved` or `expired`; no human denial to compare against) |
| J9 decision context | `(specialist_panel id, state_hash)`; questions vary with candidate count, so prompt_version varies per call | `'1'` | 25 subjects with repeated identical rows (79 rows) | n/a | lost | as J1 | none |
| J10 KB passage | `(panel subject, state_hash)` | `'1'` | 3 duplicate groups (12 rows) | n/a | fail-open: no verdict ⇒ all pages kept (`kb-corpus.ts:110`) | as J1 | none — panel outcome not linked |
| J11 challenger | `(<j>@<model>, subject, state_hash)`; deterministic sample `sha256(judgment|state_hash)` (judgment-service.ts:180-181) | inherits | never queues (`noWait`), dropped when busy (ledger `dropped_busy`) | shares limiter/breaker; a challenger failure never opens the primary breaker (typesafe-client.ts:117-118) | `settleChallengers` on shutdown (:185) | frozen deep copy of the state (:191) | `jev-challenger.ts`: names_file regex, D5 operator labels, blind relevance labels |

## 4. Measured fields per jev integration

### 4.1 Frequency, latency, cost (ledger #780/#803 + `judgments`)

Ledger `llm_model_calls` where `consumer='jev' OR provider='typesafe'`: **2 543 rows, first 2026-10-06T04:22Z** (jev calls
before 10-06 are not in the ledger: UNKNOWN there; the `judgments` rows go back to 09-21). `purpose` is set only from
10-12 (#803).

| Ledger slice | n | p50 ms | p95 ms | tokens_in (est.) | money |
|---|---|---|---|---|---|
| `jev-1.13.0`, purpose `jev:systemone`, ok (10-12 → 10-22) | 677 | 234 | 1 855 | 573 719 | **UNKNOWN** (`list_price_cost` NULL) |
| `jev-1.14.0`, purpose `jev:challenger`, ok (10-16 → 10-22) | 43 | 221 | 395 | 42 582 | UNKNOWN |
| `jev-1.13.0`, no purpose, ok (10-06 → 10-11) — latency still included queue wait | 1 253 | 372 | 301 492 | 684 027 | UNKNOWN |
| failures: `queue_full` 288 (10-08 07:26, one discovery burst), timeout 279 (10-06/07), http_529 3, timeout 1 | 571 | — | — | 0 | — |

Volume now: 324 calls in the last 7 days (~46/day; 255 on 10-14 alone, the day of the discovery pause). Token counts
are estimates (`ceil(body.length/4)`, `typesafe-client.ts:106`); `tokens_out` is always 0; the ledger under-reports
against the judgment rows (DI-001 `COST_RECONCILIATION.md` §2: 0.79 M vs 1.34 M). The value allocator (30 d, judgment rows
own the tokens) gives: decision_context 778 624, checker_second_opinion 650 354, failure_cause 335 097, proposal_prescreen
257 864, kb_passage_relevance 232 657, risk_atomic 145 021 (≈ 2.40 M). USD per call: **UNKNOWN** — no TypeSafe price is
recorded anywhere in the repo or the ledger (`LLM_COST_BASIS` marks typesafe `metered`, `model-selector.ts:49`).

Per judgment (`judgments.latency_ms`, non-error rows; includes queue wait before 10-11):

| Judgment | n | n (30 d) | decisions yes / no / uncertain / error | p50 ms | p95 ms | avg input tokens |
|---|---|---|---|---|---|---|
| proposal_prescreen | 332 | 328 | 234 / 83 / 14 / 1 | 278 | 2 062 | 719 |
| checker_second_opinion | 203 | 203 | 174 / 21 / 7 / 1 | 1 493 | 4 646 | 3 134 |
| reflection_triage | 169 | 169 | 99 / 52 / 18 / 0 | 542 | 1 142 | 1 223 |
| failure_cause | 274 | 274 | 56 / 19 / 194 / 5 | 242 | 563 | 1 178 |
| commons_contribution | 1 368 | 1 368 | 1 059 / 29 / 275 / 5 | 290 | 781 | 794 |
| commons_idea | 1 327 | 1 327 | 210 / 948 / 165 / 4 | 291 | 847 | 619 |
| discovery_relevance | 3 930 | 3 930 | 263 / 332 / 3 041 / 294 | 3 851 | 228 296 | 778 |
| risk_atomic | 218 | 218 | 0 / 213 / 3 / 2 | 288 | 995 | 602 |
| decision_context | 276 | 276 | 50 / 226 / 0 / 0 | 262 | 706 | 2 622 |
| kb_passage_relevance | 170 | 170 | 132 / 38 / 0 / 0 | 227 | 343 | 1 319 |

### 4.2 Confidence, calibration, FA/FR against ground truth, outcome linkage, human intervention

| Judgment | Confidence profile | Calibration status | FA / FR vs ground truth | Downstream outcome linkage | Human intervention |
|---|---|---|---|---|---|
| proposal_prescreen | 4 Noul; decision bands (`band`, :21) | `names_file` vs PATH_RE: ECE 0.079, AUROC 0.959 (JC-001 §3, n = 196). Product of 3 Nouls vs `verified` (prod, today): Brier 0.322, **AUC 0.683**, n = 255, 101 positives — ranks, not calibrated | Skip rule (JC-001 holdout): risk 0.20 [0.07, 0.45] → REJECT (NE-001). Operator labels on `no` rows: 55 "ok" / 1 "wrong" (09-28 → 10-12, context only per D5-NO) | `self_improvements.status`; latest-verdict × status today: `yes` → verified 101 / regressed 66 / archived 30 / infra 25; `no` → archived 41, regressed 2, other 3 (cross-tab, not a test) | 56 operator labels; requeue from /decisions |
| checker_second_opinion | Choice + 3 atomic Nouls; floor 0.6 | Not calibrated. κ(jev, run outcome) 0.381 [0.17, 0.58] (L3 v2 §3a; `honest-numbers.ts:67-109`) → `enforce_eligible` false | Agreement with the LLM checker 155/202 (76.7 %); jev never chose `needs_revision` when the checker said `insufficient_evidence` (30 of 36 such cases jev = `accepted`). Run status is not correctness ground truth | `worker_leases → loop_runs.status` (202/203 linked): jev `yes` → completed 130/174; jev `no` → completed 2/21 | none |
| reflection_triage | Choice, floor 0.6 | none | none (all 169 subjects `archived`) | `self_improvements.status` (no variance) | none |
| failure_cause | Choice + Noul; floor 0.6 | none; 194/269 non-error rows below the floor (72 %) | none in DB. Cause mix (non-error): infra 171, wrong_approach 54, missing_context 28, flaky_check 10, parse_error 6 | learner → `memory_candidates` (`dream:cause:*`); no credit path (allocator `INSUFFICIENT`) | memory candidate review |
| discovery_relevance | Choice + Noul; floor 0.6 | none; 83.6 % of non-error rows `uncertain` | DI-001 relevance: 7 labels, all INSUFFICIENT (C precision 1.00 on coverage 2/7; jev marked 5 of 6 human-checked units uncertain). **0 blind labels in prod** (#835 UI live since 10-15) | unit creation / keyword-gate override (acting) | 1 of 242 yes-units human-checked (#825 audit) |
| risk_atomic | 4 Nouls, bands | none | none; all approvals in the window `approved` or `expired` — no human denial to compare against. 213/216 rows agree with the keyword class on a test-only population | `approvals.status` | the human approves (104 approvals by the operator in 30 d) |
| decision_context | 1 Noul per candidate memory (> 0.7) | none | none | none (shadow, nothing injected) | none |
| kb_passage_relevance | 1 Noul per page (≥ 0.5 keeps) | none | none | none (panel outcome not joined) | none |
| forecast:jev_calibrated (code on prescreen answers) | p ∈ [0, 1] | histogram (source × bucket), `forecasters.ts:23-35` | Paired, n = 175 resolved (91 verified): Brier **0.250** vs base-rate forecaster 0.317. A constant at the observed prevalence (0.52) scores 0.2496 → **no skill shown** beyond prevalence | `self_improvements.status` | none |

### 4.3 Test–retest reliability from existing logs (no new call)

Identical `(judgment, subject, state_hash)` re-judged by the same pinned model (re-runs that already happened):

| Judgment | pairs | same decision | median max \|Δp\| | max \|Δp\| |
|---|---|---|---|---|
| failure_cause | 72 | 69 (95.8 %) | 0.04 | 0.14 |
| proposal_prescreen | 48 | 47 (97.9 %) | 0.02 | 0.06 |
| decision_context | 54 | 54 | 0.02 | 0.09 |
| discovery_relevance | 9 | 8 | 0.03 | 0.07 |
| kb_passage_relevance | 9 | 9 | 0.02 | 0.03 |

jev is **not bit-reproducible** on identical input (probabilities move by up to 0.14), but decisions agree 187/192
(97.4 %). `failure_cause`'s retry of an `uncertain` row on an identical state (`dream-state-service.ts:96-97`) changed the
decision in 3 of 72 cases: a paid re-roll, not new evidence.

### 4.4 JEV-114 and T1 (read-only accrual; no analysis of the registered endpoints)

- JEV-114: 43 paired rows (risk_atomic 12, failure_cause 10, decision_context 7, kb 5, checker 5, prescreen 4); decision
  agreement 39/43. Ground-truth-carrying pairs: at most the 4 prescreen pairs (names_file); D5 labels predate the
  challenger, and there are 0 blind relevance labels. Target 100 by 2027-01-14 (Amendment 1): at the current accrual it
  will end **INSUFFICIENT_EVIDENCE** unless a labelled population grows (§D of the experiment plan).
- T1 local System One (`local-qwen36-a3b`, 09-28 → 09-30, now off): agreement with jev discovery 76/145 (52 %),
  contribution 41/60, idea 43/55; p50 ≈ 10 s vs jev ≈ 0.3 s. Retired by the operator 09-30 ("stay on jev").

## 5. State of #819, #822, #825 (and the reused PRs)

| PR | Merged | On main | Deployed | What is verified |
|---|---|---|---|---|
| **#819** Gate A gated evidence (`gatedEvidence`, `ELIGIBLE_GATED`, `gate_policy prod_gates/v1:<sha12>` on every trial decision) | 2026-10-13 22:51, `3b2e0032` | yes | yes — plan: "14-10 00:04Z deployed e27720b8 (#819 #820 #821 #818 #824): healthy"; prod build today contains it | Failing-first tests (17/18 failed on old main), full suite 4 522 passed. **Open:** Codex P1 — `gradedScorer` (`dream-evolution.ts:119-131`) still returns a stored `graded:` score regardless of `success`; Codex P2 — write-test evidence not persisted. No prod measurement of Gate A since #819 found (plan: dream evolution off 10-18; prod env today has `DREAM_EVOLUTION_ENABLED=true`, re-enable time UNKNOWN) |
| **#822** gym attempts bound to gate-policy identity (`GYM_REQUIRE_GATE_POLICY_HASH`, default off; `gatePolicyClass`) | **no — OPEN (HOLD)** | no | **no** | 14 tests in the PR. Held because it edits `remote-gym-service.ts` (TG-001 surface). TG-001 r2 ended INCONCLUSIVE 10-17; plan: "unblocked only if no extension is chosen". Not wired into Gate A eligibility even after merge (plan: AND into `ELIGIBLE_GATED` later). Codex P2: the lost-worker bulk update writes `gym_result` without the binding. Prod: env flag absent (consistent) |
| **#825** reversible pause for `discovery_relevance` (`DISCOVERY_RELEVANCE_PAUSED`, durable fenced backlog) | 2026-10-14 06:24, `934dd5ac` | yes | yes — plan: "DISCOVERY PAUSE LIVE 14-10 07:2xZ" | **Verified today in prod:** `DISCOVERY_RELEVANCE_PAUSED=true`; last `discovery_relevance` row 2026-10-14T07:20:51Z; `discovery_relevance_backlog` 1 638 rows all `unjudged` (paused_at 10-15 07:20 → 10-22 07:20). Codex P2s (unit-path rows not re-queued; trial clocks lost on drain; paused counts double-counted) remain open per the PR. The pause stays (directive) |
| #779 JC-001 | 10-11 | yes | docs | REJECT (NE-001) |
| #780 ledger + NE registry | 10-11 | yes | yes | `llm_model_calls.purpose/experiment_id/cost_*` present in prod schema; cost columns NULL for jev |
| #794 E2 `decideObserved` | 10-12 | yes | yes | `judgment-service.ts:49-58` |
| #803 purpose tags | 10-12 | yes | yes | `jev:systemone` / `jev:challenger` purposes present from 10-12 |
| #824 provenance_json | 10-13 | yes | yes (10-14 00:04Z) | first provenance rows 2026-10-14T00:18Z. Codex P2: the digest omits `facts` (`pathExists`, `testOnly`) that change verdicts — still true (`judgment-provenance.ts:58` digests `state` only) |
| #827 DI-001 scoring | 10-14 | yes | docs | primary INSUFFICIENT |
| #828 execution-value challenger | **OPEN** | no | no | INSUFFICIENT |
| #829 relevance benchmark | 10-15 | yes | docs | 7 labels, INSUFFICIENT; 558 labels planned |
| #835 blind labelling UI | 10-15 | yes | yes | **0** relevance labels in prod today |
| #944 BEAM-001 | **OPEN** | no | no | jev: REJECT as a beam substitute |
| #948 MCP/A2A + 3 permission fixes | 10-21 | yes | yes (in build) | — |
| #959 MFR-001 FALSIFIED + NE-013 | **OPEN** | no | no | NE-013 not on main |

## 6. Every other decision point (non-jev)

Paths under `packages/server/src/services/` unless prefixed. "Prod" = container env today (code default in brackets when
it differs). 30-d volumes are read-only counts from prod (window 2026-09-22 → 2026-10-22). Level = the highest of
L1–L6 (§2) with evidence. Class uses the operator rule's vocabulary: **approval, promotion, code, risk, fitness** (jev
forbidden) vs routing, relevance/classification, safety, scheduling.

### 6.1 Decisions that change real state

| Decision point | Where it decides | Mechanism | Class | Prod flag | 30-d volume | Persisted | Outcome link / ground truth | Human override | Level |
|---|---|---|---|---|---|---|---|---|---|
| Panel consensus → agent approval | `specialist-panel-service.ts:603-627` → `self-improvement-service.ts:221-241, 259-277` | LLM panel (`SELF_IMPROVEMENT_REVIEW_MODEL=gemma4:31b:cloud`, fallback claude) + consensus rule (unanimous, avg conf ≥ 0.8) | approval | `SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED=true` | 415 panels (218 goal_created); panel-approved proposals: 10 verified / 8 regressed / 6 infra / 5 archived | `specialist_panels`, `specialist_reviews`, `self_improvements.approved_by='agent:approver:*'` | `self_improvements.status`; panel Brier 0.33 (BEAM B7); DI-001 committee/panel INSUFFICIENT | reject / requeue routes | L5 (outcome-linked, no skill shown) |
| Oracle-lane bypass (no panel) | `self-improvement-service.ts:53-54, 224, 265-268` | rule | approval | `ORACLE_LANES_SKIP_PANEL=true`, `ORACLE_LANES_AUTO_APPROVE=true` | 189 proposals: 92 verified / 60 regressed / 22 infra | `approved_by='agent:oracle-lane:*'` | status | requeue | L5 |
| Maker auto-approve (J5 test-gap / mutation-gap, oracle lanes) | `loop-daemon.ts:386-393` + scope rule `autonomy-shadow-service.ts:58-71`; enforced `loop-verification-service.ts:153-155, :262` | rule | approval | `LOOP_AUTO_APPROVE_TEST_GAP=true`, `…_MUTATION_GAP=true` | approvals decided by `autonomy:oracle-lane-v1` 191, `autonomy:test-gap-rule-v1` 130, `autonomy:gym-rule-v1` 30 | `approvals.decided_by`, `worker_leases.metadata.auto_approved_scope` | scope gate, status | yes | L5 |
| Execution approval (human) | `approval-service.ts:180-259`, routes `routes/approvals.ts:160/195/228` | human | approval | `APPROVAL_TTL_MS=43200000` | 104 approved by the operator; 7 expired; **0 denied** | `approvals` | `earned-autonomy.ts:19-26` joins to status | — | L5 (no denials → FA/FR of the human gate unmeasurable) |
| Approval inheritance | `approval-inheritance.ts:24-44` (used `loop-daemon.ts:417-426`) | rule (same action hash, ≤ risk, TTL) | approval | `APPROVAL_INHERIT_ENABLED=true` | UNKNOWN | `decided_by='inherit:*'` | status | — | L4 |
| CommandRiskClassifier → require_approval / deny | `command-risk-classifier.ts:33-135`; `execution-engine.ts:328`; `loop-worker-executor-service.ts:603-652` | keyword regex | **risk** | always on | 2 166 assessments: high 2 038 (94 %), low 90, medium 38 | `risk_assessments` | approvals it causes (all approved → no FR signal) | policies | L4 |
| Policy decision | `policy-decision-service.ts:26-52` | rule (`approval_policies`) | risk / approval | always on | UNKNOWN | `risk_assessments`, `audit_logs` | — | edit policies | L4 |
| LLM checker verdict | `loop-worker-executor-service.ts:418`, parse `loop-service.ts:2655-2675`, gate `:449` | LLM (`LOOP_CHECKER_RUNTIME=hermes`; F2 v2 randomises family) | **code** | `LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED=true` | 1 556 checker leases: accepted 1 117, needs_revision 71, insufficient 29, rejected 1, no verdict 338 | `worker_leases.metadata.verdict`, `loop_runs.gates_json` | merge survival; κ(checker, outcome) 0.318; seeded F1 AUC 0.95 (L3 v2 §3a) | manual verdict route (human attestation) | L5 (seeded validation) |
| Security checker | `loop-verification-service.ts:141-150` | LLM | **risk/code** | `…_SECURITY_CHECKER_ENABLED=true` | 430 leases: accepted 139, insufficient 30, rejected 3, needs_revision 2, none 256 | as above | SEC-F1 AUC 0.975 (L3 v2) | manual verdict | L5 |
| Run verification gates (separation, isolation, diff threshold, tests/lint/typecheck, scope) | `loop-verification-service.ts:100-188` | rule + executed checks | **code** | always on | 2 430 runs: completed 2 250, blocked 111, cancelled 42, failed 26 | `loop_runs.status/gates_json` | `recordOutcome` → status | human merge | L5 (executed) |
| Test-only auto-merge | `loop-auto-merge.ts:49-198`, revocation `:201-236` | rule + CI + 10 % human audit sample | **promotion/code** | `LOOP_AUTO_MERGE_TEST_ONLY=act` | 117 evaluated: merged 28, audit sample 10, ineligible 79 | `loop_runs.metadata.auto_merge` | merge survival (22/22 survived where settled — "cannot fail", L3 v2 §4b), reverts, CI | re-enable route; revocation | L5 (oracle ceiling) |
| Dependency lane | `dependency-lane.ts:148-256` | rule + CI | promotion | `DEPENDENCY_LANE_MODE=shadow` | 21 decisions (would_rebase 15, skips 6) | `dependency_lane_prs` | main CI | re-enable route | L3 (shadow) |
| Maker-species Thompson bandit | `runtime-bandit.ts:35-52`, applied `loop-daemon.ts:598-616` | Beta-Bernoulli Thompson | routing → **fitness** reward | `LOOP_BANDIT_ENABLED=true`, species `opencode,remote@workstation/atomic@llama-router`, **`LOOP_BANDIT_MAX_SHARE=0.8`** (default 0.1) | 443 selections | `worker_leases.metadata.bandit`, `loop_events` | `skill_outcomes.success`; propensity rebuilt by MC (`bandit-propensity.ts:25-29`), SNIPS report only | outage fallback overrides | L5 (reward = gate verdict, not GT) |
| Proposal-priority Thompson | `self-improvement-service.ts:457-474` | Thompson, always on, **θ not logged** | scheduling | no flag | every proposal | `self_improvements.priority` only | none (propensity lost) | — | L4 |
| Genome trial / promotion | `dream-evolution.ts:588-711`, `genome-promotion.ts:44-52` | McNemar / graded rule, Gate A band, holdout | **promotion/fitness** | `DREAM_EVOLUTION_ENABLED=true`, `DREAM_PROMOTION_RULE=both`, `GYM_PROD_GATES=true` | genomes: 1 active, 2 trial, 6 inconclusive, 10 retired; 0 promoted (L3 v2) | `genome_trial_results`, `maker_genomes` | gym tests on frozen holdout (GT) | none (no route) | L5 |
| Evolve on-target gate + ranking | `evolve-selection.ts:58-64`, `evolve-fitness-service.ts:20-41` | rule | **fitness/code** | `LOOP_EVOLVE_ENABLED=true`, `GRADED_CONTEST_MODE=shadow` | UNKNOWN | lease metadata, `loop_events` | executed tests | none | L4 |
| Memory promotion | human `routes/swarm-governance.ts:198-213`; LLM panel `memory-candidate-review-scheduler.ts:135-149`; machine `proof-run-service.ts:481, 817, 838, 864, 1254` | human / LLM panel / code | **promotion** | `MEMORY_CANDIDATE_REVIEW_ENABLED=true`; `PROOF_RUN_MEMORY_FLYWHEEL` unset (= on) | promoted 150 (operator 138 + human 12); proof-run-service 26 rejections | `memory_candidates` | memory holdout (EXP-3, readout 10-27) | yes | L4 |
| Content safety (NVIDIA) | `content-safety.ts:58-94`; acts at `kb-corpus.ts:40-41` | LLM classifier (nemotron) | **safety** | `CONTENT_SAFETY_MODE=shadow`, scope `decision` | 6 096 rows total | `judgments content_safety` | none (no labels) | none | L4 (KB delete acts in every mode) |
| Queue hygiene / recovery / self-heal | `queue-hygiene-service.ts:56-136`, `loop-recovery-service.ts:122-150`, `scheduler-registry.ts:104-130` | rule | scheduling | `QUEUE_HYGIENE_ENABLED=true`, `SELF_HEALING_SCHEDULER_ENABLED=true` | UNKNOWN | status columns, `judgments scheduler_recovery` | ticks again | yes | L4 |
| Ollama failover | `inference-failover.ts:85-98` | rule | routing | `OLLAMA_AUTO_FAILOVER=on` | UNKNOWN | `system_state` | — | — | L4 |
| Gym hack classifier (remote canonical gym) | `gym-hack-classifier.ts:18-30`; `remote-gym-service.ts:241-253` | regex | fitness | acts in remote gym; local `HACK_DETECTOR_MODE=shadow` | UNKNOWN | gym results | — | — | L4 |

Latency and money for the non-jev mechanisms are outside the jev ledger slice used here; their token side is in DI-001 `COST_RECONCILIATION.md` (30 d to 10-13: 134.1 M lease tokens, 3.53 M per merged PR, 214 k per valid reviewer verdict; USD UNKNOWN). Committee tokens are not recorded (DI-001 `LOSS.md`).

### 6.2 Shadow, advisory or measurement-only

`auto_approve_shadow` rule-v1 (268 rows: 256 no / 12 yes), `panel_weighted/unweighted` (197 each), committee + resident
forecasts (`committee-swarm.ts:150-221`; `COMMITTEE_SWARM_ENABLED=false`, rows until 10-19; arena gate on), model selector
(`model-selector.ts:121-140`, `MODEL_SELECTOR_MODE=shadow`), EVC effort controller, value allocator, fitness view,
`FAIL_BEFORE_PASS_AFTER` (shadow), settlement execution (shadow), weak-assertion check (shadow; auto-merge requires `pass`),
proposal near-duplicate (shadow), negative-evidence check (shadow), `needs_you_ranking`, council and multi-agent consensus
(API only, no consumer), JudgeService (heuristic; `judge_calibration.actual_outcome` never written), Phase-1 PR-review stub
(`GITHUB_PR_REVIEW_RUNTIME` unset), Gate A (report only, `evolution-evidence.ts:379-384`), governance gate
(`GOVERNANCE_GATE_ENABLED=true`, floor 30; can only tighten).

### 6.3 Dead or unenforced safety paths (code facts; relevant to domain D)

`ToolBroker.evaluateToolCall` (`tool-broker.ts:184`) has no external caller; **MCP tool permissions
(`mcp_tool_permissions.decision`) are catalogued but never enforced at call time** (`routes/mcp.ts:93`);
`ExecutionModePolicyService.shouldBlockMerge` only via an uncalled `checkTaskCompliance` (`execution-engine.ts:1266`);
`DataClassificationEnforcement` uncalled; `sandbox_policies` and `approval_policies.auto_approve` unread;
`egress-classification.ts` `checkProviderRoutingV2` "NOT wired" (:71-87). Enforced today: runtime admission
(`execution/runtime-admission.ts`), CommandRiskClassifier → approval, spawn depth budget (default 0), env allowlist,
`RUNTIME_ALLOW_SKIP_PERMISSIONS=false`, outbound deny list (set). None of these is a jev candidate (§D collision).

### 6.4 Human intervention summary

The operator is the only human decider seen in 30 d: 104 execution approvals (0 denials), 56 D5 labels (to 10-12), 138
memory promotions, requeues/dismissals (`requeue` 29, `requeue_dismiss` 79 rows), manual checker verdicts (route, count
UNKNOWN). Blind relevance labels (#835): **0**.

## 7. Ecosystem outside Djimitflo

No jev / TypeSafe / System One integration exists in any other repo on this machine (search with `rg --no-ignore` over
`/Users/dlandman`, excluding vendored false positives). `~/.djimit/bin/djimit-host-agent.py:51-53` only lists a
`systemone` service name; the workstation's `djimit-systemone-llm.service` (:8096) is the T1 local endpoint, retired 09-30.
Automated decisions elsewhere are deterministic: roborev `src/events.mjs` (severity → priority 1:1, regex task-type
routing on the event name — "completed" goes to triage regardless of severity, contrary to AGENTS.md; `--dry-run` forces
`triage:true`, `bin/roborev.mjs:67`); loop-engineering (fixed phase-cost "budget", injection regex gate, keyword QA gates,
72 h escalation auto-reject; writes into a local Djimitflo DB path by default, `tools/config.py:11-15`); DjimitKBWiki
(policy config only: `require_approval: true`, no automatic ingest). None is a jev candidate under the rule.

## 8. Method and limits

- Code: `origin/main` `5dfc6cdb` in an isolated worktree; every `file:line` was read, not inferred. Non-jev inventory
  cross-checked by a second read of the cited lines.
- Prod: `ssh vps-agentical` → `docker exec -i -e NODE_PATH=/app/node_modules djimitflo-live node -` with a script on stdin
  that opens `/data/djimitflo.sqlite` with `{ readonly: true, fileMustExist: true }` and only runs `SELECT` / `PRAGMA
  table_info`. Env values were printed only for an allowlist of mode/flag keys (secret-like names excluded); the TypeSafe
  key was reported as present/absent only. No prod code other than the deployed build's own `node_modules` was loaded; no
  branch code ran in the container.
- Queries (re-runnable): per-judgment counts, decisions and `latency_ms` percentiles; ledger rows where
  `consumer='jev' OR provider='typesafe'` grouped by model × purpose × status; latest-verdict × `self_improvements.status`
  cross-tabs; paired `forecast:base_rate` / `forecast:jev_calibrated` Brier on resolved statuses (verified/applied = 1);
  prescreen product AUC; `checker_second_opinion` reason parsing joined `worker_leases → loop_runs`; identical
  `(judgment, subject_id, state_hash)` groups for test–retest; `<judgment>@<model>` vs primary pairs (JEV-114 accrual
  only); the latest `value_allocation` row's consumer table.
- Not analysed on purpose: the outcome breakdown of the D5-NO population (only its confident-NO **count**), any
  JEV-114 accuracy endpoint (only pair counts), any running experiment's arm comparison.
- Limits: the ledger starts 2026-10-06 (earlier jev calls: UNKNOWN); token counts are estimates; USD UNKNOWN; latency
  before 10-11 includes queue wait; run status and `self_improvements.status` are outcome proxies (DI-001 LABELS shows
  `regressed` is mostly ENV / NO_VERDICT, not a quality label); no human labels exist for KB passages, failure causes,
  memory selection, risk or content safety.

