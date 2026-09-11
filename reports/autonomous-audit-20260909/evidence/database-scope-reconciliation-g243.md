# G243 database-scope reconciliation

Read-only comparison of the two local SQLite inputs used by the audit:

```text
node scripts/table-reachability.mjs .data/audit.sqlite
  tables=165, statically unreachable=11

node scripts/table-reachability.mjs .data/djimitflo.sqlite
  tables=167, statically unreachable=11
```

The capability graph intentionally uses `.data/audit.sqlite` as its disposable,
reproducible semantic fixture. The root `audit:tables` command defaults to
`.data/djimitflo.sqlite`, the runtime-shaped database. The schemas overlap
completely except for two runtime-only tables: `context_cache` and
`github_webhook_deliveries`. Both are source-reachable (`context_cache` is read
and written by context compression; webhook delivery records are read and
written by the webhook route), so their absence from the disposable fixture
was a graph-input omission, not an unreachable capability. There are no
graph-only tables, and the same 11
tables are classified statically unreachable in both scans.

The generator now runs and stores both scans (`table-reachability.json` and
`table-reachability-runtime.json`) and emits the comparison in
`capability-graph.json`. This removes the previous silent omission of the two
runtime-only tables without treating static source references as execution or
production-liveness proof. No database rows were changed.
