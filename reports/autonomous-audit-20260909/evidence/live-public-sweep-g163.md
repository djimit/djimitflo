# G163 — current public production sweep

Date: 2026-09-10

Read-only requests to `https://djimitflo.agentical.nl` returned:

| Endpoint | Status | Observation |
|---|---:|---|
| `/` | 200 | Dashboard HTML served |
| `/api/version` | 200 | `0.5.8`, `Djimitflo API` |
| `/api/health` | 401 | Auth boundary is enforced (`AUTH_REQUIRED`) |
| `/explore/robots.txt` | 200 | Public crawler policy and sitemap link |
| `/explore/sitemap.xml` | 200 | Valid empty XML urlset |
| `/explore/leaderboard` | 200 | Redacted public leaderboard JSON |

The deployed public surface is reachable and the protected health route is
fail-closed. No authenticated production session, commit identity, or
mutation was available, so this does not certify private route semantics or
deployment parity.
