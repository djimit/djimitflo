# ADR 0001: Djimitflo is the core of the Djimit ecosystem; Paperclip is retired

Status: accepted 2026-09-21 (operator decision), phase 1 implemented.

## Context

Until now Paperclip (control VPS, `paperclip.service`, v2026.831.1) was the "work control plane": durable work intake,
coordination and human approval state, with Djimitflo as the execution plane (roborev → Paperclip → Djimitflo).
Measured on 2026-09-21:

- Nearly idle: 1 issue created in 24 h; 851 issues tracked by the bridge (583 done, 124 backlog, 38 blocked, 34 in review),
  almost all between 2026-08-21 and 2026-09-14. The `djimit-paperclip-bridge` timer has not run since 2026-09-14, roborev's
  incoming files stop at 2026-09-04.
- Fragile: its Postgres runs on `100.77.58.72:5433` (workstation `agenticservices`, the same machine as Ollama), which produced
  10,306 `CONNECT_TIMEOUT` errors in 24 h during that host's outages. Locally hotfix-patched (`paperclip-hotfixes-*`,
  `review-policy.patch`), 12 GB on disk, ~1 GB RAM.
- Duplicated: Djimitflo already owns goals, work items, approvals with policies, audit and agents. Two task ledgers and two
  approval gates meant a worker approval lapsed unseen. 858 agent-board work items were "handed off to Paperclip" with no consumer.
- Djimitflo has no direct Paperclip dependency: no Paperclip URL or token in its environment. The only inbound coupling is
  `paperclip.*` events polled from the shared event bus; the outbound coupling is JSONL "Paperclip-ready" files that landed in the
  container's HOME and were never shipped.

## Decision

Djimitflo owns work intake, approvals, execution, audit and learning closure. Paperclip is retired in four phases.

1. **Freeze intake (done in this change).** Dream tasks become native work items (`source = dream_cycle`); `roborev.finding`
   events on the event bus become work items (`source = roborev`, idempotent on `dedupe_key`); the legacy JSONL export is off unless
   `PAPERCLIP_EXPORT_ENABLED=true`; the ecosystem map shows Djimitflo as the core and Paperclip as retiring; roborev routes to Djimitflo.
2. **Archive.** Export the 851 issues (and comments) as read-only history; keep the raw dump from `paperclip-control-backup`.
3. **Read-only period (14–30 days).** Disable the dead bridge timer, watch for anything still connecting (scallop webhook,
   eve-post-processor, Dennis `paperclip-dry-run`, loop-engineering), stop accepting new work.
4. **Remove.** Stop and disable `paperclip.service`, delete releases/patches, drop the port-5433 dependency, update AGENTS.md and roborev's shipper.

## Exit criteria for phases 3 and 4

- Djimitflo has completed one verified run through the whole loop (proposal → panel → goal → approval → maker → checker → verified).
- Approvals in Djimitflo are reviewed daily (menu badge, banner and tab title exist since PR #300).
- The Paperclip agents and routines have been inspected by the operator (needs a Paperclip login) and none is in active use.
- No consumer other than the listed ones has connected during the read-only period.

## Rollback

Phases 1–3 are reversible: set `PAPERCLIP_EXPORT_ENABLED=true`, re-enable the bridge timer; the Paperclip service and data are untouched
until phase 4. Phase 4 is the only irreversible step and is gated by the criteria above plus a fresh backup.

## Consequences and open risks

- Djimitflo's model calls still depend on `agenticservices` (Ollama). Being the core requires a fallback (cloud model via LiteLLM or a small local model on the VPS).
- The authority ledger (`authority_events`) is still not provisioned; the Authority page stays hidden.
- roborev's shipper (`scripts/ship-to-paperclip.sh`, outside this repository) still needs a bus publisher for `roborev.finding` events.
