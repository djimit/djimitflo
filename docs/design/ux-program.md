# UX + integration program (Phase UX)

Operator-adopted 2026-10-04: make Djimitflo visible, reachable and connectable. Read-only UI ships directly behind
existing auth; anything that sends, closes, approves or changes permissions ships behind a new flag, default off.

## Status

| Item | What | State |
|---|---|---|
| UX-0 | Route-to-UI coverage baseline: `node scripts/ux-coverage.mjs [--json]` | done (this file) |
| UX-1 | Proof-run live updates use the subscribed WebSocket event type (#624) | done |
| UX-2 | Cockpit `genomes` type + table (#625) | done |
| UX-3 … UX-33 | live shell, permission-aware UI, inbox, draft-PR queue, schedulers, evolution page, push, agents, LLM ledger, a11y | open |

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
| U-b | Page usage (dormant pages/routes) | `GET /api/telemetry/usage` (S4), two weeks before W8 retirement (14-10) |
| U-c | Operator device / channel | **settled: Telegram** (2026-10-04) |
| U-d | Loop PR merge/close history, review latency | merge survival + RX-6 draft-queue view |
| U-e | Draft-PR token write scope | needed before any close/comment action (UX-7 follow-up) |
| U-f | Providers used per judgment / panel (egress) | UX-18 LLM usage ledger |

## Decision ledger

| Id | Decision | Status |
|---|---|---|
| UXD-1 | Alert / one-tap approval channel = Telegram (UX-12/UX-13 built with the flag off) | decided 2026-10-04 |
| UXD-2 | English-only UI, no message catalog (UX-5 default) | proposed |
| UXD-3 | Deleting orphan UI (e.g. `ComplianceDashboard`) or Lab pages | ask first, after telemetry |
