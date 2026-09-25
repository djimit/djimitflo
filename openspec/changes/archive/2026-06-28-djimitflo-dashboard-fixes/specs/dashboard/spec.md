# Spec Delta — Dashboard

## ADDED requirements

### Requirement: Repository Scan Path Input
De RepositoriesPage SHALL een pad-invoerveld tonen waarmee de operator het
workstation pad kan invullen. De scan SHALL het ingevulde pad gebruiken, niet een
hardcoded Mac pad. Als het pad niet bestaat op de server, SHALL een foutmelding worden
getoond.

#### Scenario: Operator scant workstation pad
- GIVEN de operator is op de RepositoriesPage
- WHEN de operator vult `/home/djimit/workspace/djimitflo` in en klikt scan
- THEN de API returnt 200 met repository data
- AND de repository verschijnt in de lijst

### Requirement: Workstation URLs Dynamisch
De WorkstationUrlsPage SHALL endpoint data ophalen via `GET /api/workstation/urls` in
plaats van hardcoded arrays. De data SHALL elke 30 seconden auto-refreshen.

#### Scenario: Live endpoint data
- GIVEN de operator is op de WorkstationUrlsPage
- WHEN de pagina laadt
- THEN de pagina toont live listening ports van de workstation
- AND de data vernieuwt elke 30 seconden

### Requirement: Dashboard REST Fallback
De DashboardPage SHALL initial data laden via REST API (`GET /api/tasks`, `GET
/api/agents`) bij mount. Als de WebSocket verbinding wegvalt, SHALL de pagina de
laatste REST data blijven tonen (niet leeg).

#### Scenario: Dashboard zonder WebSocket
- GIVEN de WebSocket verbinding is weggevallen
- WHEN de operator opent de DashboardPage
- THEN de pagina toont tasks + agents via REST data (niet leeg)

### Requirement: Economy Pagina
Het dashboard SHALL een Economy pagina hebben op route `/economy` die
`GET /api/swarms/economy` ophaalt en toont: per-capability p50_dollars,
verified_artifacts_per_dollar, per-run efficiency, en summary totals.

#### Scenario: Economy metrics zichtbaar
- GIVEN de operator navigeert naar /economy
- WHEN de pagina laadt
- THEN de pagina toont per-capability dollar costs + efficiency metrics

### Requirement: Federation Pagina
Het dashboard SHALL een Federation pagina hebben op route `/federation` die peers,
capabilities, en een "Register Peer" knop toont.

#### Scenario: Peer registratie
- GIVEN de operator is op /federation
- WHEN de operator klikt "Register Peer" en vult een URL in
- THEN de peer verschijnt in de peer lijst

### Requirement: Operator Intervention Knoppen
De GoalsLoopsPage SHALL Pause, Resume, Inject Knowledge, en Override Gate knoppen
tonen per goal (alleen voor admin role).

#### Scenario: Goal pauzeren
- GIVEN een running goal op GoalsLoopsPage
- WHEN de admin klikt "Pause"
- THEN de goal status verandert naar paused
- AND in-flight leases drain gracefully

### Requirement: SSE Live Event Feed
De ObservabilityPage SHALL verbinden met `GET /api/observability/stream` via
EventSource en real-time swarm events tonen in een feed met auto-scroll en
color-coding per event type.

#### Scenario: Real-time AIMD event
- GIVEN de operator is op de ObservabilityPage
- WHEN een runtime lease completeert en adjustConcurrency vuurt
- THEN de SSE feed toont een aimd_state event binnen 1s

### Requirement: Learning Curve Visualisatie
Het dashboard SHALL een learning curve tonen (success_rate, cost, retries over runs)
met trend indicators. Data komt van `GET /api/swarms/learning-curve`.

#### Scenario: Learning verbetering zichtbaar
- GIVEN er zijn ≥5 runs in de database
- WHEN de operator opent de learning curve sectie
- THEN de pagina toont success_rate en cost per run + trend (improving/degrading)
