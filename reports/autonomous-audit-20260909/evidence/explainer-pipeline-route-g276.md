# G276 explainer pipeline route validation

A synthetic local repository is admitted through the real explainer HTTP routes and processed without external credentials:

`POST /api/explainer/tasks` (local path) → `POST /api/explainer/tasks/:id/run` (`skipGraph`) → task status `completed` → `GET /api/explainer/tasks/:id/bundles` returns one persisted bundle.

The same route fixture proves missing source input returns typed 400 and missing task retrieval returns 404. Focused result: **2 files / 3 tests passed / 0 failed**. This proves local pipeline semantics, not external provider quality or production authentication.
