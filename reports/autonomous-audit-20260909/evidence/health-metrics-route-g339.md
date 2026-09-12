# Health metrics route G339

The approval HTTP fixture now mounts the canonical `/api/health` router and
executes authenticated `GET /api/health/metrics/json` for every role. Each
request returns HTTP 200 and the same route remains protected (anonymous and
invalid bearer requests return HTTP 401 on the sibling health endpoints).

This proves local authenticated metrics projection, not production telemetry.
