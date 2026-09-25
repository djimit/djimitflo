# Design — Dashboard Fixes

## 1. Architectuur

Alle fixes zijn **additive** — geen bestaande routes of services worden verwijderd.
De UI gebruikt de bestaande `ApiClient` class (`packages/dashboard/src/lib/api.ts`)
met relatieve `/api` URLs. Nieuwe endpoints worden toegevoegd aan de bestaande
Express router structuur.

```
Browser (Mac) → http://192.168.1.28:3007
  ├── /api/* (REST — relatief, werkt via server proxy)
  ├── /ws (WebSocket — window.location.host, werkt)
  └── /api/observability/stream (SSE — relatief, werkt)
```

## 2. Nieuwe API endpoints (server-side)

| Endpoint | Methode | Doel |
|---|---|---|
| `/api/workstation/urls` | GET | D2: live `ss -tlnp` data |
| `/api/swarms/learning-curve` | GET | D11: computeLearningCurve() |
| `/api/knowledge/events` | GET | D12: recente knowledge bus events |

Bestaande endpoints die gebruikt worden:
- `GET /api/swarms/economy` (D7 — bestaat al)
- `GET /api/federation/peers` (D8 — bestaat al)
- `POST /api/federation/register` (D8 — bestaat al)
- `POST /api/intervention/:goalId/*` (D9 — bestaat al)
- `GET /api/observability/stream` (D10 — bestaat al, SSE)

## 3. Nieuwe UI pagina's

| Pagina | Route | Sidebar label |
|---|---|---|
| EconomyPage | `/economy` | Economy |
| FederationPage | `/federation` | Federation |

Bestaande pagina's die aangepast worden:
- RepositoriesPage (D1: pad invoerveld)
- WorkstationUrlsPage (D2: API i.p.v. hardcoded)
- DashboardPage (D3: REST fallback)
- AgentsPage (D4: REST fallback)
- SwarmOverviewPage (D5: swarm status + capabilities)
- SwarmPage (D6: claims + mission control)
- GoalsLoopsPage (D9: intervention knoppen)
- ObservabilityPage (D10: SSE feed)
- SwarmMissionControlPage (D11+D12: learning curve + knowledge events)

## 4. WebSocket + REST hybrid pattern

```
Page mount:
  1. REST: api.getTasks() → store.setTasks(data)  (immediate, no WS needed)
  2. WS: subscribe(TASK_CREATED) → store.addTask(event)  (real-time updates)
  3. WS disconnect → REST data blijft zichtbaar (niet leeg)
  4. WS reconnect → REST refresh + WS hervat
```

Dit pattern wordt toegepast op DashboardPage (D3) en AgentsPage (D4).

## 5. SSE EventSource pattern (D10)

```typescript
const es = new EventSource('/api/observability/stream');
es.onmessage = (e) => {
  const event = JSON.parse(e.data);
  // append to event feed
};
// cleanup: es.close();
```

Events: `aimd_state`, `convergence`, `capability_transition`, `recovery`,
`meta_evolution`, `injection_defense`, `negotiation`.

## 6. Risks

- **R1**: SSE heeft keepalive elke 15s — als de verbinding wegvalt, moet de UI
  reconnecten. Mitigation: exponential backoff reconnect.
- **R2**: Nieuwe pagina's voegen bundle size toe. Mitigation: lazy-load routes.
- **R3**: Workstation URLs endpoint voert `ss` uit op de server — dit is een shell
  command. Mitigation: alleen toegankelijk voor admin, output gesanitised.
