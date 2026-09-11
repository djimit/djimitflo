# G378 — live/reference and GitHub differential

Read-only live checks on 2026-09-11:

- `https://djimitflo.agentical.nl/` → HTTP 200, nginx/Express shell.
- `/api/version` → HTTP 200, `{"version":"0.5.8","name":"Djimitflo API"}`.
- `/api/health`, `/api/openapi.json`, `/api/health/deep`, `/api/health/metrics/json` → HTTP 401 `AUTH_REQUIRED`.
- Live shell asset: `index-4v75G2Yu.js` (297,945 bytes); local dashboard build asset: `index-CVJfGHY7.js`. Hash/name drift is observed, not deployment identity proof.
- Live bundle contains 37 explicit React route declarations (including `/login` and `/`); the local crawl recorded 38 URL patterns including its harness entry. Anonymous shell responses do not prove authenticated page semantics.

GitHub read-only differential:

- `origin/main` = `259773b68d1d328195d72f74e176dc2d9924f215`.
- Audit checkout HEAD = `c0c8d72ba9bf4eba368c16c73b838ad4a36123c5`.
- `HEAD...origin/main` = `0 3`; GitHub main is three commits ahead (`#184`, `#186`, `#188`).
- The working tree already contains the social-runtime surfaces from #186; the Qdrant search timeout from #188 was reintroduced locally and is covered by the existing knowledge fallback behavior. No blind cherry-pick was performed because the audit checkout contains a large, independently verified dirty patch set.

Limit: production authentication, authenticated UI state, deployed commit identity and external-provider behavior remain unverified.
