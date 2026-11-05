# NE-017 — Orca (`stablyai/orca`) as DjimitFlo runtime substrate: REJECT

**Decided:** 2026-11-04 (operator decision) · **Subject:** `stablyai/orca` (CLI, headless `orca serve`, Electron desktop app) · **Evidence level:** three source reviews; decision on fit, topology and trust (nothing installed, built or run)

## Review history
| Date | Review | Outcome |
|---|---|---|
| 2026-10-24 | Assimilation review at `976fa11e` (PR #1002, [`docs/research/orca`](../orca/)) | Of 13 candidates only process-group termination adopted, adapted in-house as ORCA-PG (`RUNTIME_PROCESS_GROUP_KILL`). Everything else REUSE_EXISTING or REJECT. |
| 2026-10-25 | Delta review `976fa11e → 92fd257b` (`docs/audits/djimitflo-aios-l4/README.md`) | No new adoption candidate. Scheduler load scope, the `setsid` sweep and Codex app-server approvals are DjimitFlo backlog items. |
| 2026-11-04 | Substrate review (this entry) | REJECT as runtime substrate. |

## Why not (2026-11-04)
- **Not deployable as a worker.** No Orca binary exists on any DjimitFlo host. The CLI ships with the Electron desktop app or as the headless `orca serve`.
- **Wrong execution model.** Orca's workers are agent CLIs in Orca PTY terminals, steered by a human. DjimitFlo runs headless one-shot leases with gates and evidence.
- **Topology conflict.** Remote placement is desktop-driven: the desktop pushes to SSH hosts. That conflicts with the pull-only fleet rule that the VPS never calls the workstation.
- **Does not close S0.** Orca has no sandbox, so maker isolation stays unsolved.
- **Already present in DjimitFlo:** leases with fencing (#947, #1088), the executor abstraction with runtime admission (`execution/runtime-admission.ts`), approvals, the audit hash chain and the outbound guard.

## Allowed
Adapting a single Orca mechanism in-house, without Orca code or a dependency, when a verified DjimitFlo defect needs it (precedent: ORCA-PG). Reading Orca's MIT source stays allowed.

## Guard
`forbidden_code_patterns`: `stablyai/orca`, `orca serve` (server and dashboard source, runbook, package manifests, lockfile names, MCP and agent settings).

## Reopen
Both must hold: (a) a measured DjimitFlo gap that only Orca closes, and (b) Orca running inside the workstation pull worker behind `remote_maker_jobs`, at a pinned version with a contract snapshot. Reopening permits a bounded, flagged evaluation, not adoption.
