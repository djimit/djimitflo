## ADDED Requirements

### Requirement: Checker workers can execute independently

Het systeem SHALL checker leases via een eigen execution bridge kunnen uitvoeren, gescheiden van maker leases en zonder file mutation permissions.

#### Scenario: Checker execution requires completed maker

- **WHEN** `/api/loops/runs/:id/execute-checker` wordt aangeroepen voor een checker lease
- **AND** de gekoppelde maker lease is niet `completed`
- **THEN** weigert Djimitflo checker execution
- **AND** rapporteert Djimitflo dat maker output eerst beschikbaar moet zijn

#### Scenario: Checker receives maker evidence

- **WHEN** Djimitflo een checker worker start
- **THEN** krijgt de checker maker diff, assignment packet, stdout path, stderr path, deterministic check output en gate summary
- **AND** krijgt de checker een read-only instruction contract

#### Scenario: Checker writes verdict evidence

- **WHEN** de checker worker klaar is
- **THEN** bewaart Djimitflo checker stdout, stderr, runtime usage, exit status en warnings
- **AND** schrijft Djimitflo checker trace spans en before/after checkpoints
- **AND** normaliseert Djimitflo checker output naar een checker verdict

### Requirement: Loop closure requires maker, deterministic gates and checker verdicts

Het systeem SHALL mutating loop output pas als klaar markeren nadat maker execution, deterministic gates en onafhankelijke checker verdicts slagen.

#### Scenario: Maker success alone cannot complete mutating loop

- **WHEN** een maker lease `completed` is met exit status 0
- **AND** checker verdict of deterministic gates ontbreken
- **THEN** blijft de loop status `verifying`
- **AND** mag de loop niet `completed` worden

#### Scenario: Deterministic checks fail before checker acceptance

- **WHEN** tests, lint, typecheck, secret scan of diff threshold faalt
- **THEN** markeert Djimitflo de relevante gate als failed
- **AND** mag een LLM checker pass deze failure niet overschrijven

#### Scenario: Verified mutating output becomes ready for human merge

- **WHEN** maker execution succeeded
- **AND** deterministic gates pass
- **AND** checker verdict is accepted
- **AND** de loop is niet high-risk of security checker verdict is accepted
- **THEN** markeert Djimitflo de loop als `ready_for_human_merge`
- **AND** blijft merge, push en deploy verboden zonder human approval

#### Scenario: High-risk output requires security checker

- **WHEN** een loop auth, secrets, security, infra, policy of production impact raakt
- **THEN** vereist Djimitflo een accepted `security_checker` verdict
- **AND** kan een maker of gewone checker de security gate niet vervangen

### Requirement: Dashboard supports the closed-loop operator flow

Het systeem SHALL runtime contract, worker execution, checker execution, warning gates, token efficiency en closure status zichtbaar maken in de dashboard flow.

#### Scenario: Runtime contract drift is visible before spawn

- **WHEN** een runtime adapter status `drifted` of `unavailable` is
- **THEN** toont het dashboard welke runtime is geraakt
- **AND** toont het dashboard de ontbrekende capability of flag
- **AND** biedt het dashboard geen run action die gates bypassed

#### Scenario: Operator can execute maker and checker without bypassing gates

- **WHEN** een maker lease `prepared` is
- **THEN** kan de operator via dashboard de maker execution starten
- **AND** na maker completion kan de operator checker execution starten
- **AND** gebruikt het dashboard dezelfde guarded API endpoints als CLI automation

#### Scenario: Ready-for-human-merge is distinct from completed

- **WHEN** alle non-human gates pass maar mutating work nog niet human-approved is
- **THEN** toont het dashboard status `ready_for_human_merge`
- **AND** toont het dashboard dat completion/merge nog human approval vereist

### Requirement: Goals batch registers ordered work without automatic worker spawn

Het systeem SHALL een geordend `/goals` batchplan kunnen gebruiken om vervolgwerk te registreren en te decomposen zonder automatisch worker leases te starten.

#### Scenario: Batch creates goals in dependency order

- **WHEN** de operator `goals.batch.json` uitvoert
- **THEN** maakt Djimitflo voor iedere entry een `/api/goals` record
- **AND** bewaart Djimitflo dependency keys in goal metadata
- **AND** blijft `auto_spawn_workers = false`

#### Scenario: Batch decomposition is safe

- **WHEN** batch goals zijn aangemaakt
- **THEN** mag Djimitflo `/api/goals/:id/decompose` voor iedere goal uitvoeren
- **AND** maakt decompose geen worker leases
- **AND** vereist iedere mutating continue/execute actie daarna expliciete operator approval
