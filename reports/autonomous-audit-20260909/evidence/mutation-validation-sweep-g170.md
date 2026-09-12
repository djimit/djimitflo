# G170 safe mutating-route semantic sweep

Scope: 13 additional local CRUD/consensus mutation routes replayed once with empty JSON against a fresh built runtime on `127.0.0.1:3203`, using a disposable SQLite database and temporary admin. External/provider, deployment, worker and repository-changing routes were excluded by design.

Before repair, `/api/advanced/feedback` leaked `SQLITE_CONSTRAINT_NOTNULL` as HTTP 500 when `source` and feedback fields were absent. The route now validates source, category, original/corrected decisions, reason and bounded confidence before persistence. `/api/agi/consensus/debates/:debateId/resolve` also returned a misleading 200 for an absent debate; it now returns typed 404 `NOT_FOUND` before resolution.

Post-fix replay: all 13 routes returned deterministic validation or missing-resource responses (12×400, 1×404), with no 500s. Runtime logs corroborate the responses. The new assertions are included in `mutation-validation.test.ts`. This is bounded empty-input evidence, not proof of every valid mutation path or external execution.
