# G172 workflow resource-boundary replay

Fresh built-runtime replay against a disposable SQLite database verifies missing workflow resources now fail closed:

- `POST /api/advanced/workflows/missing-workflow/nodes/missing-node/status` → 404 `WORKFLOW_NODE_NOT_FOUND`
- `POST /api/advanced/workflows/missing-workflow/nodes/missing-node/approve` → 404 `WORKFLOW_NODE_NOT_FOUND`
- `POST /api/advanced/workflows/missing-workflow/nodes/missing-node/reject` → 404 `WORKFLOW_NODE_NOT_FOUND`
- `GET /api/advanced/workflows/missing-workflow/next` → 404 `WORKFLOW_NOT_FOUND`

No SQLite row is created or updated. Service-level existence guards and HTTP regression assertions are covered by `mutation-validation.test.ts` and the workflow service tests.
