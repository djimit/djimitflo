# Operator Cockpit 3.0: test evidence

All results come from actual runs: the builders ran tests locally in origin/main worktrees, and CI ran on every PR before its squash merge (`scratchpad/train.sh`, merging only on green checks). Nothing below is a claimed PASS without a run.

## Commands executed

| PR | Command (from `packages/<pkg>`) | Result |
|---|---|---|
| #742 | `npx vitest run cockpit-integrity.test.ts` | 7/7 pass. All 7 **fail on origin/main** |
| #742 | related suites (decisions-inbox, operator-cockpit, operator-push, outcome-attribution) | 84/84 |
| #742 | full server suite | 4114 pass / 1 fail. The failure is the typescript-parser alias test, failing only because the local node_modules lacks the alias. It passes in CI |
| #742 | full dashboard suite; `tsc --noEmit` (server, dashboard); eslint on changed files | 254/254; clean; clean |
| #742 (after the conflict rebase onto #738/#741) | dashboard `OperatorCockpitPage.test.tsx UX3.test.tsx`; server `cockpit-integrity decisions-inbox operator-cockpit operator-push outcome-attribution resource-ledger detector-scheduler` | 22/22; 57/57; tsc clean after rebuilding the shared dist |
| #739 | `detector-scheduler-health.test.ts` + 3 related suites | 32/32. Full server 4115 / 1 (same alias test) |
| #738 | dashboard suite incl. RouteSmoke + 4 new tests | 51 files, 257/257 |
| #741 | `vitest run resource-ledger intelligence-metrics approval-goal-link operator-contracts health` | 6 files, 46/46. The 3 new or changed tests fail on the old ledger |
| #740 | `cockpit-decisions-authz.test.ts` | 4 pass, 2 `it.fails` documenting gaps |
| #743 | `decision-audit-integrity.test.ts` + related | 13 files, 63/63. 5 of 6 fail on old code (F3 is a guard). Dashboard not run locally (missing dependency), so CI covered it |
| #748 | `auto-deploy.test.ts` | 9/9. **1 fails on the old script** |
| #749 | `cockpit-health-wiring.test.ts` + dashboard CommandStrip | 5 + 1 new, all fail on origin/main. Full server 4140 / 0; dashboard 259/259 |
| #750 | `stall-watch` + 4 related suites | 40/40. The new test fails on origin/main |
| all merged | GitHub CI: build-and-test (Node 22, 24), mutation-test, security-scan, sbom, CodeQL, gitleaks | green at merge |

**Prod check (read-only, after the da864adf deploy):** `operatorCockpit()` and `detectStallsWithHealth()` were called inside djimitflo-live against `/data/djimitflo.sqlite` in readonly mode. They returned 0 section errors and 0 detector errors, and their numbers match the B3 independent counts (METRIC_CONTRACTS.md).

## Adversarial scenarios (directive Phase 8)

| # | Scenario | Covering test | Status |
|---|---|---|---|
| 1 | DB query fails → guardrail not green | cockpit-integrity "a failed scorecard query is UNKNOWN"; dashboard "UNKNOWN guardrail never renders healthy" | covered (I T D) |
| 2 | > 100 decision records → counts correct | cockpit-integrity "counts all 150 requeue candidates while the page stays at 50" | covered (I T D P: prod 43 → 59) |
| 3 | Regression attribution missing → risk visible | cockpit-integrity "an unattributed regression is unknown, not maker" | covered (I T D P: 8 unknown on prod) |
| 4 | Old response after a newer one → UI stays current | OperatorCockpitPage "a slower older response never overwrites a newer one"; useResource stale-response tests (W6) | covered (I T D) |
| 5 | Overlapping GPU jobs → no double-count | resource-ledger "overlapping jobs on one host share the measured Wh" | covered (I T D) |
| 6 | Gym wins up, production flat → evolution unproven | no cockpit test. The cockpit labels throughput as "not intelligence" and evolution-evidence gates stay red, but no test asserts the unproven status | **PARTIAL / NOT COVERED** |
| 7 | Scheduler configured but not executing | detector-scheduler-health "an armed scheduler that never ticks becomes armed_not_ticking"; cockpit-health-wiring (#749) | covered (#739 D; cockpit wiring pending) |
| 8 | Stalled subsystem without telemetry → unknown/breached | detector-scheduler-health "detector query fails → UNKNOWN", "discoveries enabled but never judged is a stall" | covered (I T D) |
| 9 | Low-privilege agent attempts a decision → rejected and audited | cockpit-decisions-authz "low-privilege roles get 403 on every decision endpoint and nothing is written"; decision-audit-integrity F1/F4/F5 | covered. The 403 itself leaves no audit row; only authorised decisions are audited |
| 10 | Genome good on a reused holdout, fails independent tests → promotion blocked | `holdout_exposure` reports `reuse_risk` (#736, evolution-evidence test); no promotion block | **NOT COVERED** (detected, not enforced) |
| 11 | Memory retrieval up without outcome gain → no learning claim | evolution-evidence `memory_holdout` arm comparison with Fisher p (#695 test); scorecard reports INSUFFICIENT_EVIDENCE | partly covered (measurement exists; no test that a claim is suppressed) |
| 12 | Deploy succeeds, functional readiness fails → degradation | detector-scheduler-health "deploy done without a post-deploy verdict for 40 min is a stall" | covered (I T D) |

## Gaps
- Scenarios 6, 10 and 11 need a decision-level test, not only measurement.
- No end-to-end browser test of the cockpit; RouteSmoke is jsdom.
- No production authz probe with a viewer token.
