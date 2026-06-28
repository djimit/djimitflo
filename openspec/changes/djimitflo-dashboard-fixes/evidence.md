# Evidence — Dashboard Fixes

## Audit baseline (2026-06-28)

Server log analyse toonde aan:
- 30+ API endpoints returnen 200 (werken)
- 1 endpoint returnt 500: POST /api/repositories/scan (Mac pad probleem)
- 1 endpoint returnt 404: GET /favicon.ico (cosmetic)
- WebSocket verbinding werkt ("WebSocket client connected" in log)

## Pages die werken (API 200 in server log)

| Page | Endpoints | Status |
|---|---|---|
| GoalsLoopsPage | /api/goals, /api/loops/runs, /api/loops/catalog | ✅ |
| FleetCockpitPage | /api/swarms/status, /api/swarms/worker-pool/plan | ✅ |
| SwarmMissionControlPage | /api/swarms/intelligence/mission-control | ✅ |
| SwarmResourcesPage | /api/swarms/specialists/catalog, /api/swarms/assurance/summary | ✅ |
| TasksPage | /api/tasks | ✅ |
| ObservabilityPage | /api/observability/metrics | ✅ (maar alleen polling, geen SSE) |
| MCPPermissionsPage | /api/mcp/servers, /api/mcp/permissions | ✅ |
| UsagePage | /api/usage/quotas, /api/usage/tokens, /api/usage/recent | ✅ |
| PolicyCenterPage | /api/policies | ✅ |
| ProofRunDetailPage | /api/swarms/proof-runs/:id | ✅ |

## Pages met problemen

| Page | Probleem | Fix |
|---|---|---|
| RepositoriesPage | scan gebruikt Mac pad → 500 error | D1 |
| WorkstationUrlsPage | hardcoded data, niet dynamisch | D2 |
| DashboardPage | leeg zonder WebSocket | D3 |
| AgentsPage | leeg zonder WebSocket | D4 |
| SwarmOverviewPage | basic, alleen agents + tasks | D5 |
| SwarmPage | basic, alleen agent filter | D6 |

## Missende pagina's (endpoint bestaat, geen UI)

| Endpoint | Missende UI | Fix |
|---|---|---|
| GET /api/swarms/economy | Economy pagina | D7 |
| GET /api/federation/peers | Federation pagina | D8 |
| POST /api/intervention/:goalId/* | Intervention knoppen | D9 |
| GET /api/observability/stream (SSE) | Live event feed | D10 |
| computeLearningCurve() | Learning curve grafiek | D11 |
| knowledgeBus events | Knowledge event feed | D12 |
