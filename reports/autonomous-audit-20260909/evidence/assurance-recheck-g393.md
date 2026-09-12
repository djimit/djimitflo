# Assurance recheck G393

After the OpenCode event-boundary repair, `DJIMITFLO_LIVE_URL=http://100.86.47.122:3001 npm run assurance:truth` remains **BLOCKED fail-closed**: supported Node, dependency audit, 585/585 route contracts, MCP 56/56 and all required fleet integrations pass. OpenMythos remains blocked by certification maturity and three paired regressions. Production `/health` and `/api/version` are reachable on deployed commit `259773b68d1d328195d72f74e176dc2d9924f215`, while `/api/health/deep` is correctly 401 without operator credentials; local audit checkout remains dirty.

No deployment, merge, push, credential use or external mutation was performed.
