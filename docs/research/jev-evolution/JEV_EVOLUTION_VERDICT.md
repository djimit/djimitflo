# JEV evolution verdict — DJIMIT-JEV-EVOLUTION-L3-001 (deliverable G)

DRAFT. Evidence: `JEV_CAPABILITY_FORENSICS.md`, `DECISION_TAXONOMY.json`, `JEV_OPPORTUNITY_MATRIX.md`,
`DECISION_EXPERIMENT_PLAN.md`, `DECISION_INTELLIGENCE_ARCHITECTURE.md`, `JEV_EVOLUTION_BACKLOG.md` (this directory).
Snapshot 2026-10-22, prod build `5dfc6cdb`. No new jev or LLM call was made.

## Verdict

**RETAIN jev as a narrow, measured System One; do not expand it; verify or retire what acts.**
Overall decision: **RETAIN (narrowed)** — with one EXPERIMENT (E-KB), two ADOPT hygiene items (O2 side doors, O3 re-roll
dedupe) and two RETIRE items in forbidden domains (O4, timing set by the operator because of JEV-114).

| Field | Value |
|---|---|
| Current verified value | Narrow and mostly offline: `names_file` (ECE 0.079, AUROC 0.959; but code computes the same label exactly) and IMG-001 error-noul (34/34, offline). No jev integration shows an improved outcome (L6 = 0 of 10). |
| Acting in prod | 1 (`kb_passage_relevance`, enforce, unlabelled: 88/452 passages dropped). 1 more acted until the 10-14 pause (`discovery_relevance` unit creation under `FRONTIER_UNITS_REQUIRE_RELEVANCE=true`). |
| Producing verified outcomes | 0 with ground truth that confirms the verdicts. Outcome-linked but unconfirmed: prescreen (status), checker opinion (run status). |
| Cost | Money UNKNOWN (all ledger cost columns NULL). ≈ 2.4 M estimated input tokens / 30 d over judgment rows; ≈ 46 calls/day now. |
| Latency | p50 234 ms, p95 1 855 ms (n = 677, since the limiter fix). Not a constraint. |
| Reliability | 97.4 % identical decisions on 192 identical-state re-runs; probabilities not bit-reproducible (max \|Δp\| 0.14). |
| Calibration | Only one recalibration exists (`forecast:jev_calibrated`): Brier 0.250 = constant prevalence 0.2496 → no skill. Raw prescreen AUC 0.683 (ranks, uncalibrated). |
| Governance gaps | `discovery_relevance` acts while labelled shadow and is missing from `GATE_READ_JUDGMENTS`; judgment rows re-pointed after insert; `threadGated` reads an `off` judgment; `input_digest` omits `facts`; allocator `VALUE_PROVEN` for KB passage relevance is `decision_consumed`, not outcome. |
| Running experiments touched | none. D5-NO accrual 0 confident-NO clusters since cutoff (count only); JEV-114 ≤ 4 ground-truth pairs of 100 (count only). |

## Top findings (ranked)

1. jev has never produced a verified, outcome-improving decision in Djimitflo; the one place it acts today is unlabelled.
2. The proposal pre-screen never parked a proposal (`prescreen_park` = 0 rows ever; the enforce window wrote 21 × `yes`),
   NE-001 rejects its cascade, and D5-NO has accrued 0 confident-NO clusters since its cutoff — its own rule will end it
   INSUFFICIENT_EVIDENCE at 2027-01-09 unless the proposal mix changes.
3. 33 % of jev input tokens (checker opinion + risk atomic, ≈ 795 k / 30 d) go to domains the operator rule forbids for
   jev; neither has a consumer; risk atomic carries no information (213/216 agree with keywords on a test-only population).
4. Two shadow paths act or can act through side doors (discovery unit creation; Commons thread gate) and the allocator
   does not see the first as decision-consuming.
5. The best-calibrated jev capability (`names_file`) duplicates a deterministic check that already runs; the only
   ground-truth source JEV-114 has in practice is that same regex.

## Collisions with the binding rules (explicit)

| Directive item | Rule it collides with | Resolution in this design |
|---|---|---|
| Domain D (tool execution safety) | never jev for risk; jev is not a security boundary (`typesafe-client.ts:6-7`) | jev REJECT; deterministic allow/deny + human approval stay authoritative |
| Domain E (model routing) | routing feeds fitness/promotion; NE-001 forbids confidence routing | jev REJECT as authority; at most a text feature to a deterministic router once a routed-outcome label exists (none today) |
| P6 (evolutionary strategy selection) | never jev for fitness | jev REJECT; genome trials/gates unchanged |
| `discovery_relevance` under `FRONTIER_UNITS_REQUIRE_RELEVANCE=true` | code calls unit creation "a promotion" (`expert-source-units-service.ts:123, :143`) | stays paused (#825); reopen only via DI-001 `RELEVANCE_EVOLUTION.md` §8; operator decides whether unit creation is "promotion" (if yes: jev may only rank, a rule decides) |
| `checker_second_opinion`, `risk_atomic` (shadow) | code / risk | RETIRE; timing = operator because JEV-114 pairs exist on both |
| `forecast:jev_calibrated` | predicts `verified` = a fitness quantity | zero-cost measurement only, never a gate |
| D5-NO READY outcome (if ever) | would let jev park proposals before the panel (approval-adjacent) | outside this design; D5-NO's own protocol says READY only allows *proposing* enforce to the operator |
| Prescreen dedupe / names_file retirement | D5-NO frozen population; JEV-114 label source | deferred to after 2027-01-09 / 2027-01-14 or an operator amendment |

## Highest-value experiment

**E-KB** — blind labels on ≈ 188 (question, page) pairs to verify the one acting jev path against a cosine cutoff and
keep-all. Mandatory arms reuse logged scores: **0 model tokens, ≈ 2 h operator labelling.** Optional local / reasoning
arms ≈ 0.9 M tokens (USD UNKNOWN). Needs operator authorization before it starts.

## What would change this verdict

- E-KB shows false-drop upper bound ≤ 0.15 and non-inferiority to cosine → `kb_passage_relevance` becomes the first
  verified acting jev capability (L5), and an outcome link to panel decisions is the next step to L6.
- DI-001 relevance reaches its sufficiency rule (≥ 50 labels, κ lower bound ≥ 0.4) with incremental value over the
  cheap baseline → discovery relevance may be reopened under its §8 rule.
- A recorded TypeSafe price makes the cost side computable; until then every value-per-cost statement about jev is
  UNKNOWN.
