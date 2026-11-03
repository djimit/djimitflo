# W8 DB retirement assessment — 9 tables

The operator decided on 14-10 to **keep** the tables. This document is the assessment that a later drop
decision would need. It proposes **no destructive migration**, and none is part of `chore/w8-retirement`.

## How the evidence was collected

- **Production DB** `/srv/djimitflo/data/djimitflo.sqlite` (WAL mode, `PRAGMA foreign_keys = 1`), read on
  2026-10-14. Nothing ran inside `djimitflo-live`. Each read was a throwaway sibling container
  `docker run --rm --network none --user 1001 --entrypoint node djimitflo:main-44dd558 /probe.js` with the data
  directory mounted. The script was a self-written better-sqlite3 script opened with `{ readonly: true }`, with no
  app imports.
- **Historical snapshots**, read the same read-only way: `djimitflo.sqlite.pre-os-upgrade-20261002`,
  `djimitflo.backup-recovery-20261012T185328Z.sqlite` and `djimitflo.backup-epoch1-freeze-20261014T113448Z.sqlite`.
  On top of these, the `tableCounts` of all 5 backup manifests in `/srv/djimitflo/data/backups` (2026-09-08)
  were checked.
- **Code references**: a grep of `packages/*/src` and `scripts/` on the branch for every table name. That covers
  static SQL, `hasTable(...)`-guarded dynamic SQL, and loops over `sqlite_master`.
- **Audit trails**: `audit_events`, `audit_logs` and `compliance_audit_log` were searched for any row whose
  type, action, resource or entity column mentions one of the tables. There were 0 hits for all 9.

## Summary

| Table | Schema owner (creator) | Rows now | Rows in history | Remaining code readers/writers on the branch | FK | Drop-ready? |
|---|---|---|---|---|---|---|
| `workflows` | `WorkflowGraphService` constructor (`CREATE TABLE IF NOT EXISTS`, added c1cdffb9 2026-07-04); **no migration** | 0 | 0 in all snapshots and manifests | none (dynamic only: backup table counts) | parent of `workflow_nodes`, `workflow_edges` (ON DELETE CASCADE) | yes, after operator OK |
| `workflow_nodes` | same | 0 | 0 | none | → `workflows.id` CASCADE | yes, drop together with `workflows` |
| `workflow_edges` | same | 0 | 0 | none | → `workflows.id` CASCADE | yes, drop together with `workflows` |
| `governance_feedback_loops` | `GovernanceFeedbackLoopService` constructor (fead1461 2026-07-22); no migration | 0 (AUTOINCREMENT, no `sqlite_sequence` row: never inserted) | 0 | none | none | yes |
| `governance_improvement_proposals` | same | 0 | 0 | none | none | yes |
| `memory_evolution_leases` | `MemoryEvolutionService` constructor (547fbb32 2026-07-16); no migration | 0 | 0 | none | none (soft refs `loop_run_id`, `memory_candidate_id`, not enforced) | yes |
| `repository_indexes` | `RepositoryIndexService` constructor (03ca5c4d 2026-07-23); no migration | 0 | 0 | none | parent of `code_chunks` (CASCADE) | yes |
| `code_chunks` | same | 0 | 0 | none | → `repository_indexes.id` CASCADE | yes, drop together with `repository_indexes` |
| `messages` | **`database/migrate.ts:607`** + `database/messages.sql` (f1d37952 2026-06-14) + `database/schema.ts:71`; also `mcp-server/src/database/schema.ts:67` | 0 | 0 | **live guarded readers**: `board-protocol.ts:55` (reply-target lookup), `agent-communication-service.ts:1146` (cross-store idempotency check), `board-handoff-service.ts:73` (handoff history) | → `agents.id` ×2 ON DELETE CASCADE | **no.** Correction to the first version of `RETIREMENT_REVIEW.md`: this is not a drop candidate |

The `memory_access_log` table was also created by `MemoryEvolutionService`, but `migrate.ts:879` owns it too.
It holds 661 rows, is read by `assignment-context.ts`, `operator-cockpit.ts` and `provenance-dag.ts`, and is
**not** affected by W8.

## Per-table detail

### Exact identity and schema (production)

```sql
CREATE TABLE workflows ( id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','completed','failed')), created_at TEXT NOT NULL DEFAULT (datetime('now')) );
CREATE TABLE workflow_nodes ( id TEXT NOT NULL, workflow_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('start','task','parallel','gate','end')), label TEXT NOT NULL DEFAULT '', prompt TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','waiting_approval')), requires_approval INTEGER NOT NULL DEFAULT 0, approved_by TEXT, approved_at TEXT, outputs_json TEXT NOT NULL DEFAULT '{}', model TEXT, PRIMARY KEY (id, workflow_id), FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE );  -- + idx_workflow_nodes_workflow
CREATE TABLE workflow_edges ( id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, from_node TEXT NOT NULL, to_node TEXT NOT NULL, condition TEXT, label TEXT, FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE );  -- + idx_workflow_edges_workflow
CREATE TABLE governance_feedback_loops ( id INTEGER PRIMARY KEY AUTOINCREMENT, loop_id TEXT NOT NULL UNIQUE, eval_run_id TEXT NOT NULL, failures_detected INTEGER NOT NULL DEFAULT 0, proposals_created INTEGER NOT NULL DEFAULT 0, proposals_authorized INTEGER NOT NULL DEFAULT 0, proposals_executed INTEGER NOT NULL DEFAULT 0, improvement_detected INTEGER NOT NULL DEFAULT 0, score_delta REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')) );  -- + idx_gfl_eval_run, idx_gfl_created
CREATE TABLE governance_improvement_proposals ( id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL, target_finding_ids TEXT NOT NULL DEFAULT '[]', proposed_action TEXT NOT NULL CHECK(proposed_action IN ('code_fix','policy_update','skill_update','config_change')), risk_level TEXT NOT NULL CHECK(risk_level IN ('low','medium','high','critical')), status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','authorized','rejected','executing','completed','failed')), decision_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')) );  -- + idx_gip_status, idx_gip_category
CREATE TABLE memory_evolution_leases (id TEXT PRIMARY KEY, loop_run_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('memory_evaluator','memory_consolidator','memory_pruner')), runtime TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','running','completed','failed')), memory_candidate_id TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);  -- + idx_mel_loop_run, idx_mel_role, idx_mel_candidate
CREATE TABLE repository_indexes ( id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, url TEXT, last_indexed_at TEXT, file_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','indexing','active','failed')) );
CREATE TABLE code_chunks ( id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repository_indexes(id) ON DELETE CASCADE, file_path TEXT NOT NULL, content TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, chunk_index INTEGER NOT NULL, metadata_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')) );  -- + idx_code_chunks_repo, idx_code_chunks_file, idx_code_chunks_hash
CREATE TABLE messages ( id TEXT PRIMARY KEY, from_agent_id TEXT NOT NULL, to_agent_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('task_delegation','status_update','knowledge_share','alert')), payload TEXT NOT NULL DEFAULT '{}', priority TEXT NOT NULL DEFAULT 'low' CHECK(priority IN ('low','medium','high','urgent')), read_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), idempotency_key TEXT, FOREIGN KEY (from_agent_id) REFERENCES agents(id) ON DELETE CASCADE, FOREIGN KEY (to_agent_id) REFERENCES agents(id) ON DELETE CASCADE );  -- + 5 indexes incl. idx_messages_idempotency
```

Each table occupies a single 4 KiB page, the root page only (`dbstat`). There are no triggers or views on any of
them, and no other table holds an FK into them besides the parent/child pairs listed above.

### Read/write references (branch `chore/w8-retirement`)

- **Static SQL**: after W8, no non-test code references the 8 tables other than `messages`. Before W8, the only
  readers and writers were the services and routes removed in commits e8a78295 (workflows), 61232289
  (governance feedback), e3afc2fb (memory evolution) and 985b113d (repo index).
- **Dynamic SQL**:
  - `backup-service.ts:440-450` counts the rows of every table in `sqlite_master` for the backup manifest.
    This read is harmless and keeps working either way.
  - `scripts/table-reachability.mjs` is a static audit and does not name these tables.
  - `board-protocol.ts:50`, `agent-communication-service.ts:1136` and `board-handoff-service.ts:219` probe
    `sqlite_master` with `hasTable('messages')`. If `messages` were dropped, those branches would silently turn
    off. That is fail-safe, but it is still a behaviour change, which is why `messages` stays.
- **Background jobs**: none of the 8 tables appears in a scheduler, BackgroundWorkerService worker,
  `retention-service.ts` policy or `data-classification-enforcement` rule. `messages` only appears in the guarded
  readers above.
- **Fresh installs**: since the creating services are gone, a new DB no longer gets the 8 service-owned tables,
  and nothing on the branch expects them. `messages` is still created by `migrate.ts`.

### Retention and audit obligations

- No retention policy in `retention-service.ts` covers these tables.
- No audit row refers to them (0 matches in `audit_events`, `audit_logs` and `compliance_audit_log`).
- No compliance export reads them.
- They have held no data in any snapshot, so no personal data and no evidence would be destroyed.
- The tables do not appear in the holdout-epoch-1 manifest or in any genome or experiment record.

### Backup and restore feasibility

- **Backups**: `backup-service` writes a tar.gz that holds the whole `djimitflo.sqlite` plus a manifest with
  `tableCounts`. Full-file snapshots also exist next to the live DB (2026-10-02, 10-12, 10-14 ×2). Any of them
  restores the schema exactly.
- **Recreating a single table**: no data restore is needed, because there are no rows. To bring a table back,
  re-running the `CREATE TABLE IF NOT EXISTS` statements above (or reverting the W8 commit for its service,
  whose constructor recreates it on boot) is enough.

### Rollback (for a later drop, if the operator approves one)

A drop would go in its own migration: `DROP TABLE` for children before parents (`workflow_nodes`,
`workflow_edges`, `code_chunks` first), wrapped in a transaction, after a `backup-service` snapshot. Rollback is
the CREATE statements above, or restoring the pre-migration snapshot. The restore needs no data, because every
table is empty. **None of this is part of W8.**

## Decision record

- 14-10, operator: **keep all 9 tables**. W8 drops nothing.
- If a drop is ever proposed, the candidates are the 8 service-owned tables. `messages` is excluded until its
  three guarded readers are retired.
