# JEV-114: challenger-model paired shadow (protocol record)

JEV-114 was registered in #867 as the `JEV_CHALLENGER_MODEL` row of `docs/runbooks/self-improvement-loop-operations.md`
(flag table) and in `packages/server/src/services/jev-challenger.ts`: a deterministic sample of successful jev judgments is
replayed to the challenger model in shadow; evidence is `evolution-evidence.jev_challenger` (agreement and accuracy against
ground truth; null / insufficient below 20 pairs). Start: 2026-10-16. That registration named no target n and no stop date. It
is not edited; this file holds its amendments. Per NE-001, jev is never used for approval, promotion, code, risk or fitness.

## Amendment 1 (2026-10-19)

Stop condition added; verdict rules unchanged. Operator-approved 2026-10-19.

- **Target n: 100 paired judgments with ground truth** (operator-approved default, 2026-10-19), summed over judgments. A pair
  counts when it carries a names_file, D5 operator or blind relevance label (a pair with two labels counts once).
- **Rule:** stop_by = min(start + 1.25 × target ÷ accrual rate, start + 90 days).
- **Accrual: prod, read-only (`experimentsReport` on `/data/djimitflo.sqlite`, `readonly: true`), 2026-10-18 22:33 UTC:** 16 pairs in total, 2 with ground truth (proposal_prescreen, names_file) in 2.9 days: 0.68 per day. The
  projection (184 days) passes the cap, so **stop_by: 2027-01-14** (start + 90 days).
- **At stop_by:** if every arm has reached the target, the registered analysis runs once, as written. If not, the experiment
  stops at the n reached and is recorded as INSUFFICIENT_EVIDENCE (never "no effect"); a new version needs a new registration.
- **Unchanged:** arms, endpoints, safety/harm stops, analysis and decision rules. Only a stop condition is added.
- **Recorded:** `experiment-registry.ts` (`stop_by`, `stop_source`); the stall watch `experiment_overdue` reports the experiment
  after this date while it has no verdict.
