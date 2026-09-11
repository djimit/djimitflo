# Assurance recheck G392

Executed 2026-09-11 after resuming the autonomous fix.

- `npm run assurance:integrations`: PASS. Required DjimFlo, event bus, Paperclip, UAMS, Ollama and Qdrant probes returned HTTP 200; optional LiteLLM is unavailable and Context7 returns 405.
- `DJIMITFLO_LIVE_URL=http://100.86.47.122:3001 npm run assurance:live`: BLOCKED. Production `/health` is healthy and reports deployed commit `259773b68d1d328195d72f74e176dc2d9924f215`; `/api/version` is 200; `/api/health/deep` correctly requires authentication (401). The audit checkout is intentionally dirty, so commit/database identity cannot be certified.
- `DJIMITFLO_LIVE_URL=http://100.86.47.122:3001 npm run assurance:truth`: BLOCKED (fail-closed). Node, dependency audit, route/MCP contracts and integrations pass; OpenMythos held-out discrimination remains rejected with three paired regressions and certification-ready is false; live identity remains blocked.
- `npm run audit:tables`: completed; 167 tables are inventoried. Static reachability output retains explicit limitations and does not claim runtime proof.
- GitHub `origin/main` is `bba751fc039d26ff537630885238f46071597c4c` (six commits ahead of this audit HEAD); no merge or deployment was performed.

No external mutation, credential use, merge, push or deployment was attempted.
