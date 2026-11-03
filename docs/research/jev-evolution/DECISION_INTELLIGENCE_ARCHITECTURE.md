# Decision intelligence architecture — DJIMIT-JEV-EVOLUTION-L3-001 (deliverable E)

DRAFT, design only. Maps the target logical architecture onto **existing** services; no new layer is proposed where an
existing caller or test does not prove the need (project rule). Each component is **REUSE** (as is), **EXTEND** (small
change in place), **RETIRE**, or **UNCHANGED** (not a jev concern; listed for completeness).

## 1. Principle: a decision is not an authorization

```
 state ──► [policy: questions + decide()] ──► mechanism (rule | jev | LLM | human) ──► DECISION RECORD
                                                                                         │ (judgments + provenance)
                                                                                         ▼
                         AUTHORIZATION (separate, deterministic + human) ◄── reads decision only if the class allows it
                                                                                         │
                                                                                         ▼
                                                     EXECUTION ──► OUTCOME ──► ground truth / labels ──► calibration
```

- A **decision record** says what a mechanism concluded about a state (with identity, policy version, model, digest).
- An **authorization** says whether the system may act. In Djimitflo it is always deterministic rules plus a human
  (approvals, policies, risk classifier, auto-merge eligibility, `hasMandatoryProvenance`). For the five forbidden
  classes (approval, promotion, code, risk, fitness) a jev decision record is never an input to authorization — at most
  a measurement shown to a human.
- Where jev is allowed (relevance, text-grounded classification), its decision may change *what a later mechanism sees*
  (e.g. KB passages in a panel prompt) — never *whether* something is approved, merged or promoted.

## 2. Component map

| Logical component | Existing implementation | Verdict | Change (if any) |
|---|---|---|---|
| Decision class registry | `DECISION_TAXONOMY.json` (this PR, doc) + code registries `GATE_READ_JUDGMENTS` / `LEARNER_READ_JUDGMENTS` (`value-allocator.ts:120-145`) and `JUDGMENT_CONSUMERS` (`effort-controller.ts:141-154`) | **EXTEND** | Make `value-allocator.ts` registries the one code source; derive `JUDGMENT_CONSUMERS` from them; add `discovery_relevance` (acting under `FRONTIER_UNITS_REQUIRE_RELEVANCE`) — JE-1 |
| Policy definition | `JudgmentDef` (`judgment-service.ts:16-23`), `services/judgments/*.ts`, inline defs in `decision-context-service.ts:40-58`, `kb-corpus.ts:98-112` | **REUSE** | none |
| Mode control | `judgmentMode` env `TYPESAFE_<ID>_MODE` (`judgment-service.ts:25-28`) | **REUSE** | none; acting regimes labelled by the P0-11 rule (row mode = regime used) |
| System One mechanism | `TypeSafeClient` (`typesafe-client.ts`), pinned `jev-1.13.0`, limiter, breaker, ledger | **REUSE** | record list price (JE-4) |
| Challenger mechanism | `fireChallenger` (`judgment-service.ts:187-220`), `jev-challenger.ts` | **REUSE** (JEV-114 running) | none until stop_by |
| Local System One | `localShadow`, `local-shadow-queue.ts`, `scripts/local-systemone.mjs` | **RETIRE** (off since 09-30; operator "stay on jev") | remove after JE-1; fix `Number(x) || 0.2` sample bug if kept |
| System Two mechanisms | panel (`self-improvement-agent-review-service.ts`), checker (`loop-worker-executor-service.ts`), committee | **UNCHANGED** | — |
| Deterministic mechanisms | `namedPathsExist`, verification gates, risk classifier, auto-merge rules | **UNCHANGED** (`namedPathsExist` replaces jev `names_file` after D5-NO, JE-10) | — |
| Observation → decision | `decideObserved` (E2, `judgment-service.ts:49-58`) | **REUSE** | none |
| Decision record + provenance | `judgments` + `provenance_json` (`judgment-provenance.ts`) | **EXTEND** | include `facts` in `input_digest` (`canon/v2`); replace post-insert `UPDATE judgments SET subject_*` (`expert-source-units-service.ts:146, :178, :310`) with a link row — JE-1 |
| Idempotency / concurrency | backlog fenced claim + commit hook (#825, `judgment-service.ts:99-103`) | **REUSE** as the pattern | identical-state skip (JE-3) for re-judged subjects |
| Authorization | approvals, `policy-decision-service.ts`, `command-risk-classifier.ts`, `loop-auto-merge.ts`, `hasMandatoryProvenance` | **UNCHANGED** | — (no jev input, by rule) |
| Outcome linkage | `self_improvements.status`, `loop_runs.metadata.pr_outcome`, `merge-survival.ts`, `outcome-attribution.ts`, `outcome_credits` | **REUSE** | E-KB adds a label link for passages (no new table: `operator_label` rows) |
| Ground-truth capture | `operator_label` judgments (#835 `discovery-relevance-labels.ts`, E1 `e1-retrieval-labels.ts`, D5 labels) | **EXTEND** | one more label kind for E-KB (and later memory selection) |
| Calibration / evaluation | `forecast-scoring.ts`, `honest-numbers.ts`, `jev-challenger.ts`, `d5-no.ts`, `scripts/di-001/*` | **REUSE** | no new calibrator until a class has labels above its protocol's minimum n |
| Experiment management | `experiment-registry.ts` (stop_by, WIP limit, stall watch) | **REUSE** | register E-KB / E-FC / E-IMG only after operator authorization |
| Value / cost | `llm_model_calls` ledger, `value-allocator.ts` | **EXTEND** | price (JE-4); stop counting `decision_consumed` as value (allocator classes KB passage relevance `VALUE_PROVEN` with 0 verified) |
| Negative evidence | `NEGATIVE_EVIDENCE.yaml` + `negative-evidence.test.ts` forbidden patterns | **REUSE** | none |
| Effort controller hook | `recordEffortJudgment` (`judgment-service.ts:86, :126`) | **REUSE** | drops automatically with retired judgments |
| Forbidden-domain jev judgments | `checker_second_opinion`, `risk_atomic` | **RETIRE** (JE-5, timing = operator / JEV-114) | env `off` |
| Dormant jev judgments | `commons_contribution`, `commons_idea`, `reflection_triage` | **RETIRE** (JE-7) | after `threadGated` side door closed |

## 3. Failure handling (existing behaviour → required behaviour)

| Failure | Today | Required |
|---|---|---|
| jev unreachable / 5xx / 529 | breaker after 3 failures, 60 s (`typesafe-client.ts:118`); caller gets `null`, keeps its own logic (fail-open) | keep; for an **acting** relevance path fail-open = keep everything (`kb-corpus.ts:110`) — correct direction |
| Timeout / burst | limiter 6 in flight, queue 1 000, `queue_full` rows (`:46-59`); 288 queue_full on 10-08 | keep; per-judgment daily caps where bursty (R3 cap 100/day exists for discovery) |
| Invalid / missing answer | `decideObserved` → `uncertain` (`:49-58`) | keep |
| Provenance missing | promotion-like uses fail closed (`hasMandatoryProvenance`) | keep; extend to any new acting reader |
| Duplicate work / re-roll | identical-state re-judgments paid again (192 pairs) | skip identical state (JE-3) |
| Race on a decision | CAS on park (`self-improvement-service.ts:251`), fenced backlog (#825) | the fenced pattern for any new acting path |
| Crash mid-call | shadow result lost; backlog reclaims stale claims | acceptable for shadow; acting paths must be backlog-style |
| Model alias drift / sunset | pinned `jev-1.13.0`; 1.13 sunset warning (plan L1533) | pin stays until JEV-114 verdict or sunset notice; switch = new `model_version` in provenance |
| Non-determinism | max \|Δp\| 0.14 on identical input | store answers (done); never re-ask hoping for a different answer |
| Prompt injection in state | `prepareState` redaction; content safety on untrusted text; jev documented as steerable | jev never a security boundary (rule); untrusted text must pass the content-safety prompt gate before an acting jev call |
| Data egress | `api.typesafe.ai` egress class `unknown` (`egress-classification.ts:20`); checker diffs are CONFIDENTIAL (:97) | retiring checker opinion removes source diffs from egress; E-IMG needs an explicit egress decision |
| Shadow acting through a side door | `discovery_relevance`, `threadGated` | registry test fails when an acting reader is not registered (JE-1) |
| Cost unknown | ledger price NULL | JE-4; until then "UNKNOWN", never 0 |
| Experiment contamination | registry WIP limit, frozen populations | every change listed against D5-NO / JEV-114 before merge (backlog §3) |
