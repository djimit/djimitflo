# Assurance recheck — G293

- `npm run audit:ci`: exit 0; no unaccepted high/critical production advisories.
- `npm run assurance:integrations`: exit 0; bounded read-only integration probes pass.
- `npm run assurance:truth`: exit 1 by design because `assurance/live` fails the dirty isolated checkout / authenticated production identity gate and OpenMythos evidence is blocked. This is retained as an external certification limitation, not relabeled as a product pass.
- `git diff --check`: exit 0.

Local build, type-check, lint, route registration and HTTP/SQLite regression evidence remain green. No deployment, merge or external mutation was performed.
