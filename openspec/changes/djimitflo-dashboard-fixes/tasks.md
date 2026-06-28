# Tasks — Dashboard Fixes

## D1 — RepositoriesPage scan pad fix

- [x] T1.1 Voeg een pad-invoerveld toe aan RepositoriesPage zodat de operator het
      workstation pad kan invullen (bijv. `/home/djimit/workspace/djimitflo`).
- [x] T1.2 De scan button gebruikt het ingevulde pad, niet een hardcoded Mac pad.
- [x] T1.3 Toon een foutmelding als het pad niet bestaat op de server.

Validation: operator vult `/home/djimit/workspace/djimitflo` in, klikt scan, krijgt 200
met repository data terug (geen 500 error).

## D2 — WorkstationUrlsPage dynamisch

- [x] T2.1 Nieuw API endpoint `GET /api/workstation/urls` die `ss -tlnp` uitleest op de
      server en de listener data teruggeeft als JSON.
- [x] T2.2 WorkstationUrlsPage haalt data op via dit endpoint in plaats van hardcoded
      arrays.
- [x] T2.3 Auto-refresh elke 30 seconden.

Validation: pagina toont live listening ports van de workstation, niet vaste data.

## D3 — DashboardPage REST fallback

- [x] T3.1 DashboardPage laadt initial data via `api.getTasks()` + `api.getAgents()` bij
      mount, vóór WebSocket events komen.
- [x] T3.2 Als WebSocket wegvalt, toont de pagina de laatste REST data (niet leeg).

Validation: open dashboard zonder WebSocket → pagina toont tasks + agents (niet leeg).

## D4 — AgentsPage REST fallback

- [x] T4.1 AgentsPage laadt initial data via `api.getAgents()` bij mount.
- [x] T4.2 WebSocket updates vullen de store aan (niet vervangen).

Validation: open agents page zonder WebSocket → toont agent lijst.

## D5 — SwarmOverviewPage uitbreiden

- [x] T5.1 Voeg `api.getSwarmStatus()` toe voor fleet pools + resource snapshot.
- [x] T5.2 Voeg `api.getSwarmCapabilities()` toe voor capability lijst.
- [x] T5.3 Toon fleet pools (runtimes, recommended concurrency) + capabilities in
      naast agents + tasks.

Validation: pagina toont fleet status, capabilities, en agents in één overzicht.

## D6 — SwarmPage uitbreiden

- [x] T6.1 Voeg `api.getSwarmClaims()` toe voor claim ledger.
- [x] T6.2 Voeg `api.getSwarmMissionControl()` toe voor mission control summary.
- [x] T6.3 Toon claims + manifests naast agents.

Validation: pagina toont swarm intelligence (claims, manifests) naast agent lijst.

## D7 — Economy pagina

- [x] T7.1 Nieuwe pagina `EconomyPage.tsx` die `GET /api/swarms/economy` ophaalt.
- [x] T7.2 Toon per-capability: p50_dollars, p95_dollars, verified_artifacts_per_dollar.
- [x] T7.3 Toon per-run: verified_artifacts, dollars_spent, efficiency.
- [x] T7.4 Toon summary totals.
- [x] T7.5 Voeg route `/economy` toe aan de sidebar + router.

Validation: `/economy` toont dollar economy metrics per capability + per run.

## D8 — Federation pagina

- [x] T8.1 Nieuwe pagina `FederationPage.tsx` die `GET /api/federation/peers` + `GET
      /api/federation/capabilities` ophaalt.
- [x] T8.2 Toon peer lijst (URL, trust level, last seen).
- [x] T8.3 Toon capability sync status.
- [x] T8.4 Voeg "Register Peer" knop toe (POST /api/federation/register).
- [x] T8.5 Voeg route `/federation` toe aan sidebar + router.

Validation: `/federation` toont peers + capabilities. Register knop werkt.

## D9 — Operator intervention in GoalsLoopsPage

- [x] T9.1 Voeg "Pause" knop toe per goal (POST /api/intervention/:goalId/pause).
- [x] T9.2 Voeg "Resume" knop toe per paused goal (POST /api/intervention/:goalId/resume).
- [x] T9.3 Voeg "Inject Knowledge" knop toe (modal met POST /api/intervention/:goalId/inject).
- [x] T9.4 Voeg "Override Gate" knop toe (modal met POST /api/intervention/:goalId/override).
- [x] T9.5 Knoppen zijn alleen zichtbaar voor admin role.

Validation: admin kan een goal pauzeren, hervatten, kennis injecteren, en gates
overrulen vanuit de Goals & Loops pagina.

## D10 — SSE live event feed in ObservabilityPage

- [x] T10.1 Verbind met `GET /api/observability/stream` via EventSource bij mount.
- [x] T10.2 Toon binnenkomende events (aimd_state, convergence, capability_transition,
      recovery, meta_evolution) in een real-time feed.
- [x] T10.3 Auto-scroll naar laatste event.
- [x] T10.4 Color-code events per type.
- [x] T10.5 Sluit EventSource bij unmount.

Validation: observability pagina toont real-time swarm events (binnen 1s van actie).

## D11 — Learning Curve API + grafiek

- [x] T11.1 Nieuw API endpoint `GET /api/swarms/learning-curve` die
      `computeLearningCurve()` aanroept.
- [x] T11.2 Nieuwe sectie in SwarmMissionControlPage of EconomyPage die de learning curve
      toont (success_rate, cost, retries over runs).
- [x] T11.3 Toon trend indicators (improving/degrading).

Validation: pagina toont een grafiek/tabel met prestatie-verbetering over runs.

## D12 — Knowledge Bus event feed

- [x] T12.1 Nieuw API endpoint `GET /api/knowledge/events` die recente knowledge bus
      events teruggeeft.
- [x] T12.2 Sectie in SwarmMissionControlPage die claims toont die via de bus zijn
      gepubliceerd.
- [x] T12.3 Real-time update via SSE (gecombineerd met D10).

Validation: mission control toont recente knowledge bus claims in real-time.
