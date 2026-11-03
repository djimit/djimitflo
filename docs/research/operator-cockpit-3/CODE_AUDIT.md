# Operator Cockpit 3.0: code audit

Baseline: origin/main and prod **22f7fcf7** (2026-10-10; `/health` reported `commit_matches_build: true`). The local checkout on the MacBook was a stale branch (`audit/fase5-close-loop`), so all work started from origin/main worktrees.

**Status legend:**
- **I**: implemented
- **T**: tested (a test fails on the old code, or it encodes the new behaviour)
- **V**: independently verified (by a read-only prod check, separate from the author)
- **D**: deployed
- **P**: production validated
- **NP**: not proven

## Files inspected

| Area | Files | Notes |
|---|---|---|
| Cockpit | `services/operator-cockpit.ts`, `pages/OperatorCockpitPage.tsx` | 145 + 296 lines at baseline |
| Decisions inbox | `services/decisions-inbox.ts`, `pages/DecisionsInboxPage.tsx` | 105 + 231 lines |
| Stall watch | `services/stall-watch.ts` | 71 lines; detectors 1–8 |
| Schedulers | `services/scheduler-registry.ts`, `index.ts`, `bootstrap/autonomous-services.ts` | registry recorded intent (armed/off) only |
| Resource ledger | `services/resource-ledger.ts` | per-consumer Wh, north star |
| Attribution | `services/outcome-attribution.ts` | `nonMakerRunSql`, audit sampler |
| Evidence / intelligence | `services/evolution-evidence.ts`, `docs/research/intelligence-metrics/*` | read, reused, not changed |
| Contracts | `packages/shared/src/contracts/operator.ts`, `packages/dashboard/src/lib/api-contracts.ts` | key lists checked at compile time |
| Auth / audit | `routes/{approvals,self-improvement,swarm-governance,fleet-hosts,telegram,federation}.ts`, `services/{approval-service,audit-service,fleet-commands,memory-candidate-service}.ts` | see SECURITY_REVIEW.md |
| Deploy | `scripts/auto-deploy.sh`, `.trivyignore` | CI gating defects found while shipping |

The directive's path `packages/dashboard/src/lib/api-contracts.ts` existed. Paths named `intelligence-metrics.ts` were found as `services/intelligence-metrics.ts` plus `evolution-evidence.ts`. Not inspected: forecasting internals (`forecasters.ts`, `forecast-scoring.ts`), model routing (`runtime-bandit.ts`), nested spawning, and skills/memory services beyond their evidence sections.

## Defects (verified on the baseline code, then on prod)

| # | Defect | Evidence | Fix | Status |
|---|---|---|---|---|
| D1 | A failed query rendered a guardrail green: `ok: (value ?? 0) <= limit` | `operator-cockpit.ts` at 22f7fcf7 | #742 explicit `state`; null → UNKNOWN | I T V D P |
| D2 | A regression without attribution counted as a maker failure (`else split.maker += n`) | prod: 12 shown as maker = 4 `maker_failure` + 8 unattributed | #742 `unknown` class; DEGRADED while unknown > 0 | I T V D P |
| D3 | Decision counts were derived from LIMIT pages (requeue 50, pre-screen 100, memory 50) | prod: requeue shown 43, true 59 | #742 separate COUNT totals | I T V D P |
| D4 | A never-polled PR counted in both `open_prs` and `draft_prs`; one proposal counted in two sections | prod B3 | #742 dedupe; needs_you `total` | I T V D P |
| D5 | `needs_you` used `?? 0` fallbacks: a failed count read as 0 | code | #742 null + `errors[]` | I T D |
| D6 | Reflection-inflow guardrail was green while the lane was capped at 0; the expired-approvals label "not rising" did not match its rule | prod B3 | #742 NOT_APPLICABLE; honest label | I T V D P |
| D7 | `tokens_per_verified_change_7d` mixed cohorts (window spend ÷ settled verified) | prod: 2.58 M vs direct 0.96 M | #742 two named metrics (old field kept) | I T V D P |
| D8 | Stall detectors swallowed SQL errors, so an empty list read as healthy | `stall-watch.ts` `one()`/`all()` | #739 `detectStallsWithHealth` | I T D (cockpit wiring: #749) |
| D9 | The discoveries detector read healthy when nothing had ever been judged | code | #739 | I T D |
| D10 | Schedulers showed intent, not execution | `scheduler-registry.ts` | #739 status per scheduler; #749 intervals + `markRun` for 8 more | I T D (#749 pending) |
| D11 | No deploy-readiness signal (a `done` with no verdict) | — | #739 deploy detector | I T D |
| D12 | per_kWh = 12.7 verified/kWh: cloud-made changes over 23 % energy coverage; overlapping jobs double-counted Wh | prod B3: 7 overlapping pairs, 1 811 s | #741 coverage gate (≥ 80 %) + exclusive Wh | I T D |
| D13 | Approval audit named `system`; cancel and memory promote/reject were unaudited; self-approval was invisible; viewers saw Telegram emails | B4 F1, F2, F4, F5, F6 | #743 | I T D |
| D14 | The scheduled OpenWiki `update` check gated auto-deploy (it held #738–#744 and fails on some days) | prod deploy log 10-10 | #748 `AUTO_DEPLOY_IGNORE_CHECKS` | I T D P (deploy ran 15:26Z) |
| D15 | A gym at its daily cap was reported as a stall, so health read BREACHED | prod post-deploy check of da864adf | #750 status `capped` | I T (pending merge) |
| D16 | Main CI was red on a gh Go CVE (CVE-2026-78669), with no fixed gh release | Trivy on `/usr/bin/gh` | #744 `.trivyignore` with justification | I D |

## Architecture findings (not fixed)

| Finding | Confidence | Note |
|---|---|---|
| The gym and production disagree for the same species (atomic 80.8 % gym vs 5.7 % prod) | high (prod) | see EVOLUTION_VALIDATION.md |
| `countOpenLoopPrs` / `listDraftPrs` returned 0 on error | high | fixed in #749 |
| Digest showed null counts as 0 | high | fixed in #749 |
| No server-side decision prioritisation (expected value, reversibility, effort) | high | Phase 3 not built |
| Routing / swarm optimisation not evaluated in this batch | — | Phase 5 not built; see FINAL_DECISION.md |
