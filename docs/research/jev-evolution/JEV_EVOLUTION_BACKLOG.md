# JEV evolution backlog — DJIMIT-JEV-EVOLUTION-L3-001 (deliverable F)

DRAFT, ordered. Nothing here is started; every item needs the operator's go. Fields per item: id · title · decision ·
evidence · falsifiable hypothesis · success criterion · method · spend · risk · rollback · depends on / blocked by ·
owner of the decision. Items that already exist as a workstream elsewhere are **referenced, not duplicated** (§3).

## 1. Ordered backlog

### JE-1 — Close the shadow side doors (O2) · **ADOPT**
- Evidence: forensics §3, §6. `discovery_relevance` acts under `FRONTIER_UNITS_REQUIRE_RELEVANCE=true`
  (`expert-source-units-service.ts:120-127, :141-147, :306-313`) but is absent from `GATE_READ_JUDGMENTS`
  (`value-allocator.ts:120-135`); `UPDATE judgments SET subject_type/subject_id` after insert (:146, :178, :310);
  `threadGated` (`agent-social-autopilot-service.ts:387-397`) reads `commons_contribution` rows while that judgment is
  `off`; `input_digest` omits `facts` (`judgment-provenance.ts:58`, #824 Codex P2).
- Hypothesis: after the change, every jev row a code path acts on is classed `decision_consumed`, and no judgment row
  changes identity after insert. Falsified by any acting reader the registry test does not list.
- Success: one failing-first test per door; allocator classifies `discovery_relevance` as decision-consumed when the flag
  is on; a link table (or `subject_link` row) replaces the UPDATE; `threadGated` returns false when the judgment mode is
  `off`; `facts` included in the digest (new `canon/v2`, old rows keep `v1`).
- Method: one PR, flags default to today's behaviour where a behaviour changes; tsc + lint + related suites.
- Spend 0 · Risk: allocator table changes (shadow, never applied) · Rollback: revert · Depends on: none · Decision owner:
  operator (merge). Does not touch the #825 pause.

### JE-2 — E-KB: verify `kb_passage_relevance` (O1) · **EXPERIMENT**
- Evidence: forensics §2 J10, §4.2; allocator `VALUE_PROVEN` = `decision_consumed` 170, verified 0.
- Hypothesis H-KB; success / method / arms / decision rule: `DECISION_EXPERIMENT_PLAN.md` E-KB.
- Spend: 0 model tokens (mandatory arms), ≈ 2 h labelling; optional ≈ 0.9 M reasoning tokens.
- Risk: none in prod (read-only). Rollback of the outcome: `TYPESAFE_KB_PASSAGE_RELEVANCE_MODE=shadow`.
- Depends on: protocol freeze (sha256) + a labelling card (reuse the #835 card pattern; a new label type, not the
  discovery manifest). Decision owner: operator (authorize; act on result).

### JE-3 — Re-roll dedupe for identical states (O3) · **ADOPT**
- Evidence: forensics §4.3 (192 identical-state re-judgments, 187 same decision; failure_cause retry flips 3/72).
- Hypothesis: skipping identical-state re-judgments changes no consumed decision. Falsified if a 14-day shadow counter
  shows > 5 % of would-skip cases with a different consumed decision.
- Success: calls of failure_cause / decision_context / kb −≥ 5 % with 0 consumed-decision changes.
- Method: shadow counter (`would_skip`) first, then a flag `JEV_IDENTICAL_STATE_SKIP` (default off).
- Spend 0 · Risk: loses a lucky retry · Rollback: flag off · **Excludes `proposal_prescreen`** until D5-NO ends
  (2027-01-09) · Decision owner: operator.

### JE-4 — Record the TypeSafe price (O12) · **ADOPT**
- Evidence: 2 543/2 543 jev ledger rows with NULL `list_price_cost`; `tokens_out` 0; tokens are chars/4.
- Hypothesis: with a recorded per-token (or per-call) price, jev cost per judgment is computable; falsified if TypeSafe
  bills on a basis the ledger cannot express.
- Success: `list_price_cost` non-null on new jev rows; allocator `UNKNOWN_COST` disappears for jev.
- Method: operator supplies the contract price → `LLM_COST_BASIS` / price table; use the API's `usage` when present.
- Spend 0 · Risk: none · Rollback: unset · Decision owner: operator (price is contractual data).

### JE-5 — Retire jev in forbidden domains (O4) · **RETIRE**
- Evidence: operator rule 11-10; JC-001 §4; allocator `NO_CONSUMER`; κ(jev, outcome) 0.381 not enforce-eligible;
  risk_atomic 213/216 uninformative.
- Hypothesis: no decision reads these rows (verified in code: `effort-controller.ts:147, :153`; only the
  `honest-numbers` evidence card reads checker opinions).
- Success: both modes `off`; ≈ 795 k input tokens / 30 d saved; evidence cards show "retired" instead of stale numbers.
- Method: env change (operator) — **after JEV-114's stop_by (2027-01-14) or with an explicit JEV-114 amendment**, because
  17 of its 43 pairs are on these two judgments.
- Risk: loses the checker-vs-jev κ card · Rollback: env back to `shadow` · Decision owner: operator.

### JE-6 — E-FC: failure-cause classifier vs hand labels (O5) · **EXPERIMENT**
- See `DECISION_EXPERIMENT_PLAN.md` E-FC. Spend 0 (logged arms). Decision owner: operator. If it fails: replace with
  the deterministic classifier, RETIRE the judgment (removes ≈ 335 k tokens / 30 d).

### JE-7 — Retire dormant jev paths (O11) · **RETIRE**
- `commons_contribution`, `commons_idea`, `reflection_triage`, T1 local shadow: off or without input since 09-30, no
  ground truth, no consumer (except the side door closed in JE-1). Remove the definitions' call sites behind their
  flags only after JE-1. Spend 0 · Rollback: revert · Decision owner: operator.

### JE-8 — E-IMG: visual error check in CI (O6) · **EXPERIMENT**
- See plan E-IMG. Needs a CI secret and an egress decision (api.typesafe.ai egress class `unknown`). ≈ 0.18 M tokens per
  round. Decision owner: operator.

### JE-9 — `decision_context` after the memory-holdout readout (O9) · **RETAIN → decide on 2026-10-27**
- If EXP-3 shows memory injection helps: label memory relevance (E-DC, same pattern as E-KB). If not: RETIRE
  (≈ 779 k tokens / 30 d, the largest single jev consumer).

### JE-10 — `names_file` back to code; prescreen question set review (O8) · **RETIRE (after D5-NO)**
- After 2027-01-09 (D5-NO) and 2027-01-14 (JEV-114): drop the jev `names_file` question in favour of `namedPathsExist`
  (`proposal-prescreen.ts:33-38`), which already computes the label exactly.

## 2. Not in the backlog (REJECT)

jev for tool execution safety (D), model routing authority (E), evolutionary strategy selection (P6), approval /
auto-approve / auto-merge, promotion, fitness, a prescreen cascade (NE-001), reopening discovery relevance outside its §8
rule, any change to running experiment populations.

## 3. Existing workstreams referenced, not duplicated

| Workstream | Where | Relation |
|---|---|---|
| D5-NO | `docs/research/eco/D5NO_PROTOCOL.md`, `d5-no.ts` | untouched; JE-3/JE-10 wait for it |
| JEV-114 | `docs/research/eco/JEV-114_PROTOCOL.md`, `jev-challenger.ts` | untouched; JE-5/JE-10 timing |
| DI-001 relevance benchmark + labelling | #829, #835, `docs/research/di-001/relevance/` | the discovery-relevance experiment; JE-2 reuses its card pattern only |
| DI-001 decision scoring | #827 | outcome-label taxonomy reused by E-FC |
| Discovery pause | #825 | stays |
| Gate A gated evidence / gate-policy identity | #819 (merged, deployed), #822 (open, HOLD) | non-jev; no item here |
| Execution-value challenger | #828 (open) | non-jev |
| Value allocator | `value-allocator.ts` | JE-1 corrects its consumer registry; JE-4 fills its cost |
| L3 bottleneck P0-11 (shadow judgments act) | `docs/research/l3-forensics/bottlenecks.md` | JE-1 is its jev part |
