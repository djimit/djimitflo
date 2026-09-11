# G244 authenticated local dashboard crawl

The built dashboard was launched against an isolated SQLite database on
`127.0.0.1:3187` and authenticated with a disposable admin identity. The
terminal Playwright crawl loaded all 38 declared dashboard route patterns
(including representative detail/review IDs) and recorded page text, headings,
page errors and HTTP responses.

Observed result:

- All declared top-level dashboard routes rendered a non-empty page with no
  page exceptions.
- Expected fixture detail routes returned domain `404` states (`task/fixture`,
  `repository/fixture`, `proof-run/fixture`) rather than blank or crashed
  pages.
- `/authority` showed the explicit unavailable-ledger `503` state.
- A single rapid all-route crawl exceeded the server's intentional 300/minute
  API limiter and produced `429 /api/organizations` on the final routes. This
  is retained as load evidence, not classified as an application route defect.

After restarting the disposable server, two six-route batches were rerun.
Both batches completed with zero page errors and zero HTTP responses >=400.
The clean batches covered the six previously rate-limited feature routes
(`/consensus-debates`, `/predictive-analytics`, `/self-healing`, `/cognitive`,
`/self-driving`, `/explainers`) plus the remaining six routes
(`/swarm-mission-control/proof-runs/fixture`, `/workstation-urls`, `/economy`,
`/pipeline-builder`, `/federation`, `/agi-reasoning`). The expected fixture
proof-run `404` remains a domain-state check from the earlier batch, not a
crash. No production UI or external system was mutated.
