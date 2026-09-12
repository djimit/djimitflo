# Retirement plan route G342

The agent-lifecycle boundary fixture mounts `/api/retirement` and executes
authenticated `GET /api/retirement/plan/a` for a registered idle agent. The
route returns HTTP 200 with `agentId=a` and `canRetire=true`, proving the
planning projection reaches the retirement service over HTTP/SQLite.
