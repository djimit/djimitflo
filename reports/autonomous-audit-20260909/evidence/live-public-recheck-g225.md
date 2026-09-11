# G225 live public recheck

Read-only probe of `https://djimitflo.agentical.nl/`: `/` returns HTTP 200 (550 bytes), `/api/version` returns HTTP 200 with `{"version":"0.5.8","name":"Djimitflo API"}`, and anonymous `/api/health` returns HTTP 401 `AUTH_REQUIRED`. This proves public availability and the anonymous auth boundary only; authenticated production semantics and deployed revision identity remain unverified.
