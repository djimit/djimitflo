# UX + integration program (Phase UX)

Operator-adopted 2026-10-04: make Djimitflo visible, reachable and connectable. Read-only UI ships directly behind
existing auth; anything that sends, closes, approves or changes permissions ships behind a new flag, default off.

## Status

| Item | What | State |
|---|---|---|
| UX-0, 2, 2b, 3, 4, 8, 9, 10, 13, 14, 16, 17, 18, 19, 20, 21, 24, 25, 25b, 26 | coverage baseline, contracts, live shell, permission-aware UI, schedulers, evolution page, PR body v2, push + digest, scorecards, LLM ledger, JSON repair, egress, embeddings, retrieval harness, a11y, UI kit | done (each re-checked with `git log --grep 'UX-<n>'`) |
| UX-11 | draft-PR queue | done via RX-6 (36ea8c1, #634) |
| UX-30 | Lab pruning table (`ux-30-lab-pruning.md`) | done (8736cbb, #1116); **decision pending** (operator, UXD-3) |
| UX-1 | proof-run live updates | partial → UXE-06 |
| UX-5 | Dutch strings | partial → #1115 / UXE-07 |
| UX-6 | allowlist move | partial → UXE-20 |
| UX-7 | draft-PR disposition | partial → parked |
| UX-12 | Telegram commands | partial → UXE-26 |
| UX-27 | mobile layout | partial → UXE-25 |
| UX-28 | component splits | partial → #1115 / UXE-27 |
| UX-29 | role matrix in route smoke | partial → UXE-03 |
| UX-31, UX-32 | evidence pack, executive page | partial → UXE-31, UXE-32 |
| UX-33 | (see Phase UX prompt) | open |
| UX-15, UX-18b, UX-22, UX-23 | (see Phase UX prompt) | parked |

### UX evolution program (Phase UXE)

Operator-adopted 2026-11-01. Each item ships as a draft PR on `feat/ux-evo/<NN>-<slug>`; the operator merges.

| Item | What | State |
|---|---|---|
| UXE-00 | Value-gate decision card + settlement value by lane on `/evolution` (read-only); UI fitness ratchet v0 (`scripts/ui-fitness.mjs`, baseline `ui-fitness-baseline.json`) | draft PR |
| UXE-02a | Ratchet v1a: `operator_routes_ui_called` / `unmatched_calls` (a2, wraps `ux-coverage.mjs`; `unavailable` without `typescript`, never 0), `contrast_pairs_below_4_5` (a4), `max_page_lines`, `dead_ws_subscriptions`; baseline = base measurement 155 / 0 / 10 / 1301 / 6 | draft PR (stacked on UXE-00) |
| UXE-09 | Visible errors: load and action failures render as text on Policy Center, Federation, MCP Permissions, Tasks and Task detail (no `alert()`, `native_alert` 3 → 0); `useDialog` confirmation before proof-run rollback (Mission Control, proof-run detail) and worker drain / lease stop (Fleet Cockpit) | draft PR |
| UXE-00a | Guard-test list (R12): a loop PR touching a UX oracle test (`ORACLE_TEST_FILES` in `loop-auto-merge.ts`) is permanent `ineligible: oracle_test_file`; refuses more PRs, never allows more | draft PR |
| UXE-01 | Runbook default rows for `LOOP_DRAFT_PR_THROTTLE_MODE`, `LOOP_DRAFT_PR_MAX_OPEN`, `VECTOR_STRICT_DIM`, `RETRIEVAL_NORMALISE_SCORES`, `TELEGRAM_PUSH_DELAY_MS` (now in `RUNBOOK_DEFAULTS`); `LLM_JSON_REPAIR_ENABLED` row corrected (Frontier Experts only); the digest / triage tick reports as scheduler `operator_digest` with a guarded tick | draft PR |
| UXE-08 | Typed client errors: `ApiClient.request` and export downloads throw `ApiError` (`status`, `code`, `request_id` from `X-Request-ID`) with unchanged messages; `{error:'text'}` bodies show the text; `permissionError` prefers status 403; `LoadErrorNotice` lines carry the request id; server mounts the existing `requestContext` middleware | draft PR |
| UXE-03 | Role-matrix route smoke (UX-29): 7 roles × the `App.tsx` route table, offline and on synthetic fixtures; the fixture fetch answers 403 where the server's `requirePermission` (route-source inventory) would. `NAV_PERMISSIONS` gains `/evolution`, `/observability`, `/usage` (`manage:config`, UI gating only). Visible-but-403 = 0, hidden-but-permitted = 0; Agent Commons' lure and join-request panels (`manage:tokens`) are pinned in-page 403s | draft PR |
| UXE-11 | UX-4b permission memo (no code): role × permission matrix, APPROVER/`write:governance`, `GET /approvals` and `GET /self-improve/decisions` payloads, 27 mutating routes without a permission check, proposed matrix, blast radius, migration, rollback (`permission-memo-2026-11.md`) | draft PR; **decisions D-UXE-11a–f pending** (operator) |

## Coverage baseline (UX-0, origin/main 5a9d46d5, 2026-10-05)

Static: mounted routes (route-source inventory) vs `this.request` calls in `dashboard/src/lib/api.ts`. Direct `fetch`
calls (auth, streaming) and 25 dynamic calls the scan cannot resolve are not counted, so this is a floor.

**686 mounted routes; the dashboard calls 135. Operator routers: 135 / 662 (20 %). Machine routers (worker, host agent,
Telegram webhook, social runtime, spawn callbacks): 0 / 24 — no UI expected.**

Largest uncovered operator routers: swarm-intel 60 / 64, swarm 38 / 50, swarm-orchestration 28 / 36, explainer 29 / 29,
apex 16 / 16, advanced 14 / 14, discussions 14 / 14, council 13 / 13, openmythos 14 / 16, governance 12 / 21, segml ×8
(38 routes, 0 covered). Best covered: tasks 9 / 9, fleet-hosts 4 / 4, risk 2 / 2, loops 16 / 20, evidence 4 / 5,
repositories 7 / 9. Full per-router table: `node scripts/ux-coverage.mjs`.

## Unknowns register

| Id | Unknown | How it gets settled |
|---|---|---|
| U-a | Prod flags / armed schedulers | evolution flags: `GET /api/health/evolution-evidence`; schedulers: UX-8 |
| U-b | Page usage (dormant pages/routes) | **measured 31-10 (UX-30)**: `ux-30-lab-pruning.md`, 30 d of `usage_counts` |
| U-c | Operator device / channel | **settled: Telegram** (2026-10-04) |
| U-d | Loop PR merge/close history, review latency | merge survival + RX-6 draft-queue view |
| U-e | Draft-PR token write scope | needed before any close/comment action (UX-7 follow-up) |
| U-f | Providers used per judgment / panel (egress) | UX-18 LLM usage ledger |

## Decision ledger

| Id | Decision | Status |
|---|---|---|
| UXD-1 | Alert / one-tap approval channel = Telegram (UX-12/UX-13 built with the flag off) | decided 2026-10-04 |
| UXD-2 | English-only UI, no message catalog (UX-5 default) | proposed |
| UXD-3 | Deleting orphan UI (e.g. `ComplianceDashboard`) or Lab pages | ask first, after telemetry. Telemetry is in (UX-30, 31-10): per-page KEEP / MOVE / MERGE-INTO / RETIRE-CANDIDATE in `ux-30-lab-pruning.md`; decision pending |
| UXD-4 | Decision coverage (evidence keys a page reads and a test proves, `decision_keys_proven`) replaces route coverage as the primary UI target | proposed |
| D-UXE-00a | Guard-test list: loop PRs touching the UX oracle tests are never earned-auto-merged (UXE-00a) | decided 2026-11-01 (yes) |
