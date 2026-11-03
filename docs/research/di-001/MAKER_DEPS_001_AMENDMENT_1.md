# MAKER-DEPS-001 v1: amendment 1

The pre-registration is `MAKER_DEPS_001_PREREG.md`. Its sha256 is pinned in `MAKER_DEPS_001_PREREG.sha256`, so this amendment is a
separate file and the pre-registration is not edited.

## Amendment 1 (2026-10-19)

Stop condition added; verdict rules unchanged. Operator-approved 2026-10-19.

- **Rule:** stop_by = min(start + 1.25 × target ÷ accrual rate of the slowest arm, start + 90 days).
- **Accrual: prod, read-only (`experimentsReport` on `/data/djimitflo.sqlite`, `readonly: true`), 2026-10-18 22:33 UTC:** terminal goals A = 14, B = 22 since 2026-10-14 (4.9 days; 7 + 11 in the last 2 days, so accrual is not stalled).
  Slowest arm A: 2.83 per day.
- **stop_by: 2026-12-16** (2026-10-14 + 1.25 × 141 ÷ 2.83 = 62.2 days, rounded up to the day; the 90-day cap is 2027-01-12).
  Target unchanged: 141 per arm. PREREG §4 ("reaching the target is the only stop for efficacy") still holds; this date is an
  administrative stop, not an efficacy look.
- **At stop_by:** if every arm has reached the target, the registered analysis runs once, as written. If not, the experiment
  stops at the n reached and is recorded as INSUFFICIENT_EVIDENCE (never "no effect"); a new version needs a new registration.
- **Unchanged:** arms, endpoints, safety/harm stops, analysis and decision rules. Only a stop condition is added.
- **Recorded:** `experiment-registry.ts` (`stop_by`, `stop_source`); the stall watch `experiment_overdue` reports the experiment
  after this date while it has no verdict.
