# STE-001 — Simplified Technical English maker template (pre-registration)

Operator-approved 11-10. Flag `STE_001_MODE` (default off). Code: `packages/server/src/services/ste-001.ts`,
lint `packages/server/src/services/ste-lint.ts`, tests `packages/server/src/__tests__/ste-001.test.ts`.

## Hypothesis

Rewriting the fixed maker rules in ASD-STE100 style (numbered, imperative, condition first, one instruction per sentence,
no vague words, concrete limits) removes ambiguity that makers resolve wrongly — for example 'asked for a test, edited
README'. It does not add capability, so the expected effect on the verified rate is small; the most likely place to see a
difference is the out-of-scope share.

## Design

- Population: oracle-lane maker goals (test-gap, exports, mutation) — the same population as ACE-001.
- Factor: template. Arm = parity of sha256(`ste-001:` + goal id). Arm 0 = `MAKER_TEMPLATE_RULES` (today), arm 1 =
  `MAKER_TEMPLATE_RULES_STE`. Every run of a goal (retries, siblings) gets the same arm.
- Orthogonal to ACE-001 (own salt; the test checks all 8 STE × ACE cells are balanced) and to the memory holdout. Both
  experiments are analysed by main effect on the same goals; their interaction is exploratory only.
- Only the template text differs. Gates, checkers and the scope gate are identical in both arms (test pins
  `daemonCheckOptions`). Same obligations: every rule of the current template maps to an STE line (test pins the mapping).
  The STE limits are those the gates enforce: 400 diff lines when every changed file is a test (`TEST_ONLY_DIFF_MAX`),
  200 otherwise (test-gap/exports; the mutation lane allows 400, the stricter value is stated so one template fits all
  oracle lanes).
- Recording: `ste_001` on the `assignment_context` event and the maker lease, `ste-001-arm:<0|1>` on the skill outcome,
  template gene of the maker genome = the template hash. Evidence section `ste_001` in `evolution-evidence`.

## Endpoints

- Primary: verified rate per arm (production maker outcome success), intent to treat.
- Secondary: out-of-scope share (outcomes with `gate:auto_approved_scope:fail`), mean tokens per run.
- Descriptive: graded score where present (few production runs carry one).

## Sample size and power

Prod, last 30 days: about 4.5 oracle-lane goals per day, 44 % of settled ones verified (ACE-001 protocol figures).
Two-sided α 0.05, power 0.8, base rate 0.44:

| n per arm | Detectable difference |
|---|---|
| 50 | about 28 points |
| 100 | about 20 points |

Target: **100 per arm** (200 goals). Every oracle goal falls in one of the two arms, so this takes about 44 days, the same
window in which ACE-001 reaches 50 per cell. A difference below about 20 points (the expected size) will most likely end
`inconclusive`; that is a valid outcome, not a failure of the protocol.

## Analysis, stop rule, falsifier

- Interim reads are descriptive only (`collecting`). No early stop for benefit.
- Analysis once both arms reach 100: two-proportion test (or Fisher exact) on the primary endpoint, Wilson 95 % intervals;
  the same for the out-of-scope share.
- Stop early for harm: if after 30 per arm the STE arm's verified rate is 25 points or more below control, switch
  `STE_001_MODE` off and report.
- Falsifier: the hypothesis 'STE wording helps' is rejected when the STE arm is not better on the primary endpoint and not
  lower on the out-of-scope share at the target size. Adoption of the STE template as the default requires a significant
  primary gain or a significant out-of-scope reduction with no primary loss; the decision is the operator's.

## STE lint (report-only)

`ste-lint.ts` flags sentences over 20 words, vague words, passive voice and more than one imperative per sentence. On
11-10 it finds, in the current instruction templates: maker rules 6 findings (2 vague words, 2 passive, 2 multiple
instructions), checker 7 (2 long sentences, 1 vague, 1 passive, 3 multiple instructions), panel review 2 (1 long,
1 passive), security checker 0, objective scope line 0. The STE template has 0 findings (strict test). The lint changes
no prompt at runtime; rewriting the checker and panel prompts would be separate, measured changes.

## Amendment 1 (2026-10-19)

Stop condition added; verdict rules unchanged. Operator-approved 2026-10-19. The text above is frozen and is not edited.

- **Rule:** stop_by = min(start + 1.25 × target ÷ accrual rate of the slowest arm, start + 90 days).
- **Accrual: prod, read-only (`experimentsReport` on `/data/djimitflo.sqlite`, `readonly: true`), 2026-10-18 22:33 UTC:** arm 0 = 33, arm 1 = 30 since 2026-10-11 (7.9 days). Slowest arm 1: 3.78 per day.
- **stop_by: 2026-11-14** (2026-10-11 + 1.25 × 100 ÷ 3.78 = 33.1 days, rounded up to the day; the 90-day cap is 2027-01-09).
  Target unchanged: 100 per arm.
- **At stop_by:** if every arm has reached the target, the registered analysis runs once, as written. If not, the experiment
  stops at the n reached and is recorded as INSUFFICIENT_EVIDENCE (never "no effect"); a new version needs a new registration.
- **Unchanged:** arms, endpoints, safety/harm stops, analysis and decision rules. Only a stop condition is added.
- **Recorded:** `experiment-registry.ts` (`stop_by`, `stop_source`); the stall watch `experiment_overdue` reports the experiment
  after this date while it has no verdict.
