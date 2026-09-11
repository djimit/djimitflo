# G219 live public recheck

Read-only probes against `https://djimitflo.agentical.nl/` returned: root **200** (`text/html`, 550 bytes), `/api/version` **200** with `{"version":"0.5.8","name":"Djimitflo API"}`, and protected `/api/health` **401 AUTH_REQUIRED**.

This confirms public availability and the anonymous auth boundary only. Authenticated production UI semantics, deployed commit identity and external assurance remain unverified; no mutation was attempted.
