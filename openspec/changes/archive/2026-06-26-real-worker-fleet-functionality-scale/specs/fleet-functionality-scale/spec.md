## ADDED Requirements

### Requirement: Fleet pool status is visible by runtime

Het systeem SHALL worker pool status per runtime tonen zodat operatoren prepared, queued, running, blocked en completed werk kunnen onderscheiden voordat ze opschalen.

#### Scenario: Prepared leases are not active workers

- **WHEN** een loop drie prepared maker leases heeft
- **AND** geen lease runtime evidence voor running execution bevat
- **THEN** rapporteert Djimitflo `prepared_leases = 3`
- **AND** rapporteert Djimitflo `running_leases = 0`
- **AND** rapporteert Djimitflo `active_execution_count = 0`

#### Scenario: Runtime pool explains blocked capacity

- **WHEN** Codex beschikbaar is maar token budget is uitgeput
- **THEN** rapporteert Djimitflo de Codex pool als available runtime met blocked capacity reason `token_budget_exhausted`
- **AND** biedt Djimitflo geen automatische startactie voor nieuwe workers

#### Scenario: Queue depth is grouped by risk and runtime

- **WHEN** er prepared low-risk Codex leases en high-risk OpenCode leases bestaan
- **THEN** rapporteert Djimitflo queue depth per runtime
- **AND** rapporteert Djimitflo queue depth per risk class
- **AND** blijven high-risk leases zichtbaar als security/human-gated werk

### Requirement: Fleet cockpit shows topology and bottlenecks

Het systeem SHALL een dashboard cockpit bieden die goal, loop, lease, runtime, artifact, gate en next-safe-action in een samenhangende topology toont.

#### Scenario: Operator sees end-to-end worker topology

- **WHEN** een goal een loop-run met maker en checker leases heeft
- **THEN** toont het dashboard de keten van goal naar loop-run
- **AND** toont het dashboard per lease runtime, status, artifact paths, gates en latest event
- **AND** toont het dashboard welke lease de volgende veilige actie heeft

#### Scenario: Operator sees bottleneck reason

- **WHEN** een loop niet kan opschalen door ontbrekende runtime, budget exhaustion, failed gate, missing checker of missing human approval
- **THEN** toont het dashboard de specifieke bottleneck category
- **AND** toont het dashboard de evidence ref of gate die de blokkade verklaart

#### Scenario: Scale claims require evidence

- **WHEN** het dashboard worker capacity of throughput toont
- **THEN** is de waarde gebaseerd op API data, runtime evidence of expliciete unknown state
- **AND** toont het dashboard geen estimated active worker count als bewezen active execution

### Requirement: Workstation resources guide concurrency

Het systeem SHALL workstation resource signals gebruiken om aanbevolen concurrency te bepalen en veilig te degraderen wanneer de execution node beperkt is.

#### Scenario: Recommended concurrency uses resource snapshot

- **WHEN** Djimitflo resource snapshot CPU threads, load average, free memory en runtime availability heeft
- **THEN** berekent Djimitflo recommended concurrency per runtime
- **AND** bewaart Djimitflo de reasons achter die aanbeveling

#### Scenario: Low resource state blocks new running workers

- **WHEN** vrije memory of load threshold onder de configured grens komt
- **THEN** weigert Djimitflo nieuwe running worker starts
- **AND** blijven prepared leases prepared
- **AND** schrijft Djimitflo een capacity gate met blocked reason

### Requirement: Backlog can flow to scalable worker execution

Het systeem SHALL triaged backlog items kunnen omzetten naar goals, loop-runs, prepared leases en controlled worker execution zonder source reference of review evidence te verliezen.

#### Scenario: Batch planning preserves source references

- **WHEN** meerdere triaged backlog items naar goals worden geconverteerd
- **THEN** bewaart Djimitflo source, source_ref, risk_class, value_score en confidence in metadata
- **AND** kan de operator vanuit het goal terug naar het oorspronkelijke work item

#### Scenario: Multiple bounded items prepare without file conflicts

- **WHEN** twee onafhankelijke low-risk work items in dezelfde repo worden voorbereid
- **THEN** maakt Djimitflo aparte worktrees en branches
- **AND** zijn beide prepared leases zichtbaar in pool status
- **AND** start Djimitflo ze pas wanneer capacity en policy gates dat toestaan

#### Scenario: Failed workers remain auditable

- **WHEN** een worker faalt of checker de output afwijst
- **THEN** blijft stdout, stderr, diff, gates, trace en checkpoint evidence gekoppeld aan het work item
- **AND** wordt het work item niet stilzwijgend als done gemarkeerd
