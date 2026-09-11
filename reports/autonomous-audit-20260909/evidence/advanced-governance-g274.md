# G274 workflow governance boundary

The advanced approval endpoints now require the addressed workflow node to have `type = gate`. Approving or rejecting a task node returns typed `409 WORKFLOW_GATE_REQUIRED` without changing node state. Real gate fixtures still approve with durable `approvedBy`/timestamp and reject to `failed` over HTTP/SQLite.

Focused route and source-learning result: **3 files, 33 tests passed, 0 failed**. This closes a local false-success boundary only; production authentication and browser/provider behavior remain separate gates.
