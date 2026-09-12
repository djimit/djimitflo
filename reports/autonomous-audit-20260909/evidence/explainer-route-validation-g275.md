# G275 explainer route validation

Using the production-equivalent `fullSchema` fixture, the authenticated-local HTTP chain proves:

- invalid task input without `remote_url`/`local_path` → typed 400 `VALIDATION_ERROR`;
- `POST /api/explainer/tasks` persists a pending GitHub task;
- `GET /api/explainer/tasks` lists the persisted task;
- `GET /api/explainer/tasks/:id` returns the same durable task;
- an unknown task returns 404.

Focused result: **2 files / 3 tests passed / 0 failed**. This is local HTTP/SQLite route evidence; it does not execute a provider pipeline or certify production authentication.
