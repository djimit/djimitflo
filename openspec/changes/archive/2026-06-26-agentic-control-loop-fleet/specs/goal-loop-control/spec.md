## ADDED Requirements

### Requirement: Goals are measurable and decomposable

Het systeem SHALL `/goals` aanbieden als intention layer waarin doelen meetbare acceptatiecriteria, constraints, risk class en budget hebben.

#### Scenario: Goal with acceptance criteria is created

- **WHEN** een operator een goal aanmaakt met objective, constraints, budget en acceptance criteria
- **THEN** slaat Djimitflo het goal op met status `created`
- **AND** kan het goal worden gedecomponeerd zonder workers te starten

#### Scenario: Goal without acceptance criteria is rejected

- **WHEN** een operator een goal zonder meetbare acceptance criteria aanmaakt
- **THEN** weigert Djimitflo het goal met `GOAL_ACCEPTANCE_CRITERIA_REQUIRED`

#### Scenario: Dashboard shows goal and loop state

- **WHEN** een operator de Goals & Loops view opent
- **THEN** toont Djimitflo goals, loop-runs, status, gates, worker leases, blockers en review events
- **AND** biedt de view gecontroleerde loop-acties zoals create goal, start, step, continue, verify, split, retry, verdict, complete en stop
- **AND** bevat de view geen merge- of deploy-actie

### Requirement: /loop controls iterative progress

Het systeem SHALL `/loop` aanbieden als lifecycle voor start, step, run, verify, state update, next-decision en stop.

#### Scenario: Loop proposes next step

- **WHEN** een loop-run een completed step heeft
- **THEN** mag een planner-agent een volgende stap voorstellen
- **AND** beslist Djimitflo via loop contract en policy of de stap uitgevoerd mag worden

#### Scenario: Generic loop lifecycle aliases exist

- **WHEN** een operator een loop via generic lifecycle API bedient
- **THEN** ondersteunt Djimitflo minimaal start, step, verify, continue en stop
- **AND** blijven deze aliases dezelfde gates, budgets en worker lease regels gebruiken als de concrete loop endpoints

#### Scenario: Failed gate blocks continuation

- **WHEN** verification gates falen
- **THEN** mag `/loop continue` geen nieuwe mutating worker-run starten
- **AND** moet de loop retry, split, revise of escalate beslissen

#### Scenario: Rejected maker output can be retried

- **WHEN** een maker lease faalt of een checker verdict `needs_revision`, `rejected` of `insufficient_evidence` krijgt
- **THEN** mag `/loop retry` een nieuwe maker/checker lease voorbereiden voor dezelfde finding
- **AND** markeert Djimitflo de oude maker output als superseded
- **AND** tellen verify en complete alleen de actieve maker/checker keten

#### Scenario: Oversized finding can be split

- **WHEN** een finding te groot is voor een bounded maker task
- **THEN** mag `/loop split` de finding markeren als `split`
- **AND** maakt Djimitflo minimaal twee child findings onder dezelfde loop-run
- **AND** leaset Djimitflo geen worker automatisch door de split
- **AND** kan de split parent finding niet meer direct aan een maker worden toegewezen

#### Scenario: Failure threshold escalates the loop

- **WHEN** maker failures en negatieve checker verdicts de configured failure threshold bereiken
- **THEN** markeert Djimitflo de loop-run als `escalated`
- **AND** schrijft Djimitflo een `loop_escalated` event in de review bundle
- **AND** weigert Djimitflo nieuwe continue of retry worker leases totdat een mens de run beoordeelt
