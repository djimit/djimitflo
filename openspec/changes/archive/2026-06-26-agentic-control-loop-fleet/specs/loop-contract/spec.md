## ADDED Requirements

### Requirement: Loops declare a complete control contract

Het systeem SHALL iedere loop valideren tegen een contract met `goal`, `trigger`, `context_sources`, `actions_allowed`, `verification`, `state`, `escalation` en `stop_conditions`.

#### Scenario: Complete loop is accepted

- **WHEN** een loop alle verplichte velden bevat en minimaal een meetbare stopconditie heeft
- **THEN** markeert Djimitflo de loop als `valid`
- **AND** mag de loop in dry-run planning worden gebruikt

#### Scenario: Vague loop is rejected

- **WHEN** een loop alleen een brede opdracht zoals "verbeter de repo" bevat zonder stopcondities
- **THEN** weigert Djimitflo de loop met `LOOP_CONTRACT_INCOMPLETE`
- **AND** worden ontbrekende velden in de foutmelding genoemd

### Requirement: Closed loops are default for execution

Het systeem SHALL execution loops standaard als `closed` behandelen en alleen bounded open loops toestaan voor discovery of research.

#### Scenario: Open execution loop requires explicit approval

- **WHEN** een loop `mode: open` heeft en mutating actions toestaat
- **THEN** vereist Djimitflo human approval voordat workers worden gestart
- **AND** moet de loop time, token en context budgets bevatten

#### Scenario: Closed loop can execute low-risk patch

- **WHEN** een closed loop low-risk actions toestaat en alle gates definieert
- **THEN** mag Djimitflo maker/checker workers leasen binnen het geconfigureerde budget
