# DjimFlo Dashboard Fixes — UI Compleet maken

## Why

Het DjimFlo dashboard draait op de workstation en is bereikbaar via `http://192.168.1.28:3007`.
De meeste pagina's werken (API returns 200), maar er zijn 12 bekende problemen die de UX
breken of functies onbruikbaar maken. Deze change fixt ze allemaal in één plan.

## Problemen (gevonden via server-log analyse + broncode audit)

### Kritiek (broken functies)

1. **RepositoriesPage scan gebruikt Mac pad** — `POST /api/repositories/scan` faalt met
   "Repository path does not exist: /Users/dlandman/djimitflo" omdat de UI het Mac pad
   doorgeeft, niet het workstation pad.

2. **WorkstationUrlsPage is volledig hardcoded** — Geen API calls; alle endpoint data
   staat hardcoded in de component. Niet dynamisch, niet live.

3. **DashboardPage toont niets zonder WebSocket** — Als WS wegvalt, lege pagina. Geen
   REST fallback voor initial load.

4. **AgentsPage toont niets zonder WebSocket** — Zelfde probleem als DashboardPage.

### Belangrijk (beperkte functionaliteit)

5. **SwarmOverviewPage is basic** — Toont alleen agents + tasks. Geen swarm status,
   capabilities, of fleet pools.

6. **SwarmPage is basic** — Alleen een agent filter + lijst. Geen swarm intelligence.

7. **Economy endpoint heeft geen UI** — `GET /api/swarms/economy` bestaat maar heeft
   geen pagina.

8. **Federation endpoint heeft geen UI** — `GET /api/federation/peers` bestaat maar heeft
   geen pagina.

9. **Operator Intervention heeft geen UI** — `POST /api/intervention/:goalId/{pause,resume,inject,override}`
   bestaat maar heeft geen knoppen in GoalsLoopsPage.

### Nice to have (missende visualisaties)

10. **Live observability (SSE)** — SSE stream bestaat maar UI gebruikt alleen polling.

11. **Learning Curve visualisatie** — `computeLearningCurve` bestaat maar geen API/UI.

12. **Knowledge Bus events niet zichtbaar** — Geen real-time event feed in UI.

## What Changes

- **D1**: RepositoriesPage scan pad fix (workstation pad of invoerveld)
- **D2**: WorkstationUrlsPage dynamisch via API
- **D3**: DashboardPage REST fallback bij geen WebSocket
- **D4**: AgentsPage REST fallback bij geen WebSocket
- **D5**: SwarmOverviewPage uitbreiden met swarm status + capabilities
- **D6**: SwarmPage uitbreiden met swarm intelligence
- **D7**: Economy pagina toevoegen
- **D8**: Federation pagina toevoegen
- **D9**: Operator intervention knoppen in GoalsLoopsPage
- **D10**: SSE live event feed in ObservabilityPage
- **D11**: Learning Curve API endpoint + grafiek
- **D12**: Knowledge Bus event feed in Mission Control

## Non-Goals

- Geen redesign van de UI styling
- Geen nieuwe component library
- Geen mobile responsive (desktop-first)
