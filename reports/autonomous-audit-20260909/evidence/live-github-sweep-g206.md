# Live/GitHub read-only sweep — G206

Result (2026-09-10): `https://djimitflo.agentical.nl/` returns **200** HTML; `/api/version` returns **200** with `{"version":"0.5.8","name":"Djimitflo API"}`; protected `/api/health` returns **401 `AUTH_REQUIRED`**. `git ls-remote origin refs/heads/main` reports `3894d9408ed4b8bfc040ecac1573b4747cca24fa`.

No credentials, login, mutation or deployment was attempted. Private production semantics and local/remote revision parity remain unverified.
