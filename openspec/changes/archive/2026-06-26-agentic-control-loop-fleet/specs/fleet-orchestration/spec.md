## ADDED Requirements

### Requirement: Djimitflo can lease many Codex/OpenCode workers

Het systeem SHALL meerdere Codex/OpenCode workers parallel kunnen leasen voor dezelfde goal, begrensd door loop budget, concurrency en repository isolation.

#### Scenario: Parallel makers use separate worktrees

- **WHEN** een loop drie onafhankelijke low-risk tasks heeft
- **THEN** mag Djimitflo drie maker workers leasen
- **AND** krijgt iedere maker een eigen git worktree en branch met prefix `agent/loop/`

#### Scenario: Budget stops new workers

- **WHEN** een loop zijn token-, tijd- of retry-budget bereikt
- **THEN** stopt Djimitflo het leasen van nieuwe workers
- **AND** markeert de loop-run als `blocked` of `escalated`

#### Scenario: Retry budget stops new retry workers

- **WHEN** een maker output retrybaar is maar het retry-budget is opgebruikt
- **THEN** weigert Djimitflo een nieuwe retry maker/checker lease
- **AND** blijft de bestaande failed of rejected output auditable in de review bundle

#### Scenario: Runtime token budget uses reported usage

- **WHEN** een Codex of OpenCode worker echte token usage rapporteert in runtime output
- **THEN** slaat Djimitflo die usage op bij de worker lease
- **AND** gebruikt Djimitflo geen geschatte tokens wanneer runtime usage ontbreekt
- **AND** weigert Djimitflo nieuwe worker leases wanneer het configured token budget is bereikt

#### Scenario: Wall-clock budget stops new workers

- **WHEN** een loop-run langer loopt dan `max_runtime_ms`
- **THEN** weigert Djimitflo nieuwe mutating loop actions zoals continue, retry, split of maker execution
- **AND** markeert Djimitflo de run als `blocked`
- **AND** schrijft Djimitflo een `loop_budget_exhausted` event met budget type `wall_clock`

### Requirement: Maker and checker are separated

Het systeem SHALL output van maker workers laten controleren door een andere worker of deterministic gate voordat completion wordt geaccepteerd.

#### Scenario: Checker is independent

- **WHEN** een maker worker een patch of research output oplevert
- **THEN** wijst Djimitflo verificatie toe aan een andere worker lease
- **AND** kan de maker lease zijn eigen output niet definitief goedkeuren

#### Scenario: Fleet mode is required for high-risk scopes

- **WHEN** een task auth, secrets, security, infra, policy of production impact raakt
- **THEN** vereist Djimitflo fleet mode met security_checker of human gate
- **AND** is single-agent self-approval verboden

#### Scenario: High-risk completion requires security checker

- **WHEN** een high-risk loop maker output heeft en de gewone checker accepteert
- **THEN** blijft completion geblokkeerd totdat een `security_checker` lease een accepted verdict heeft
- **AND** schrijft Djimitflo de security checker verdict in de review bundle
- **AND** kan de maker of gewone checker de security gate niet vervangen

### Requirement: Swarm reality metrics distinguish registry state from active execution

Het systeem SHALL registry agents, live agents, worker leases, active executions en open work apart rapporteren zodat een gezonde swarm state zonder workers niet als actief uitvoerend werk wordt gepresenteerd.

#### Scenario: Registry rows are not counted as live workers

- **WHEN** twee agents geregistreerd zijn maar slechts één agent een recente heartbeat heeft
- **THEN** rapporteert Djimitflo `registry_agent_count = 2`
- **AND** rapporteert Djimitflo `live_agent_count = 1`
- **AND** markeert Djimitflo dat registry agent count inventory is, geen active execution proof

#### Scenario: Active execution requires runtime evidence

- **WHEN** een worker lease `running` is met runtime evidence zoals pid, session id of artifact path
- **THEN** telt Djimitflo deze mee in `active_execution_count`
- **AND** worden prepared leases niet als active execution geteld

### Requirement: Valuable loop findings can be projected to a canonical backlog

Het systeem SHALL waardevolle follow-up uit loop findings opslaan als `work_items` in de Djimitflo database zonder automatisch nieuwe workers te leasen.

#### Scenario: Scheduler projects findings to backlog

- **WHEN** een completed loop-run findings bevat
- **THEN** kan de scheduler een `candidate` work item maken met source reference naar loop run en finding
- **AND** blijft `leases_created = 0` in auto-propose mode
- **AND** maakt een tweede scheduler tick geen duplicate voor dezelfde source reference

### Requirement: Worker leases include portable assignment packets

Het systeem SHALL voor iedere maker lease naast mensleesbare instructies een machineleesbaar assignment packet schrijven met doel, context, grenzen, verwachte artifacts en stopcondities.

#### Scenario: Maker lease has an assignment packet

- **WHEN** Djimitflo een maker lease voorbereidt
- **THEN** schrijft Djimitflo `ASSIGNMENT_PACKET.json` in de worktree
- **AND** bevat de lease metadata het packet pad
- **AND** bevat het packet allowed actions, forbidden actions, expected artifacts, finding context en stop conditions

### Requirement: Memory candidates are governed before promotion

Het systeem SHALL memory candidates classificeren voordat ze naar durable memory of policy state gepromoveerd worden.

#### Scenario: Operational memory can be proposed

- **WHEN** een operational memory candidate geen secrets of policy change bevat
- **THEN** slaat Djimitflo deze op als `candidate`
- **AND** markeert Djimitflo de promotion status als `proposed`

#### Scenario: Policy memory requires human approval

- **WHEN** een memory candidate type `policy_rule` heeft
- **THEN** markeert Djimitflo deze als `review_required`
- **AND** blijft promotion geblokkeerd tot human approval

#### Scenario: Secret-like memory is rejected

- **WHEN** een memory candidate secret-like content bevat
- **THEN** weigert Djimitflo de candidate
- **AND** schrijft Djimitflo deze niet naar UAMS, Qdrant of OKF

#### Scenario: Promoted memory is searchable

- **WHEN** een approved operational memory candidate naar OKF is gepromoveerd
- **THEN** kan `/api/memory/search` deze terugvinden via promoted-memory fallback
- **AND** krijgt het resultaat trust level `validated`

### Requirement: Scheduler can turn triaged backlog into goals without workers

Het systeem SHALL triaged backlog candidates kunnen omzetten naar goals zonder automatisch worker leases te starten.

#### Scenario: Triaged item becomes a goal

- **WHEN** de scheduler tick draait met `plan_triaged = true`
- **AND** er een triaged work item zonder parent goal bestaat
- **THEN** maakt Djimitflo een goal met dezelfde objective, risk class en acceptance context
- **AND** markeert Djimitflo het work item als `planned`
- **AND** blijft `leases_created = 0`

### Requirement: Specialist panels produce auditable multi-disciplinary decisions

Het systeem SHALL gespecialiseerde panels kunnen aanmaken met expliciete profielen, onafhankelijke reviews, consensus, dissent en backlog-projectie zonder automatisch worker leases te starten.

#### Scenario: Specialist catalog exposes bounded profiles

- **WHEN** de swarm API om specialist profiles wordt gevraagd
- **THEN** retourneert Djimitflo profielen met domain, required evidence, forbidden claims en output schema
- **AND** kan een onbekend specialist id geen panel starten

#### Scenario: High-risk panels require security reviewer

- **WHEN** een specialist panel risk class `high` of `critical` heeft
- **THEN** moet het panel `security_reviewer` bevatten
- **AND** weigert Djimitflo het panel wanneer die reviewer ontbreekt

#### Scenario: Independent reviews preserve dissent

- **WHEN** alle specialisten in een panel een review indienen
- **THEN** berekent Djimitflo support, oppose, uncertain en needs_evidence counts
- **AND** bewaart Djimitflo dissenting reviews in de consensus
- **AND** markeert Djimitflo het panel als `consensus_ready`

#### Scenario: Consensus can become backlog without workers

- **WHEN** een consensus-ready panel naar backlog wordt geprojecteerd
- **THEN** maakt Djimitflo een `work_items` record met source `specialist_panel`
- **AND** bewaart Djimitflo panel id, consensus level, decision en dissent in metadata
- **AND** blijft `worker_lease_count = 0`

### Requirement: Assurance traces preserve causal swarm execution

Het systeem SHALL agentic work kunnen vastleggen als causal trace DAG zodat goals, loop-runs, workers, tools, memory updates, evals, checkpoints en reflections achteraf te reconstrueren zijn zonder secrets in evidence te bewaren.

#### Scenario: Trace spans form a causal DAG

- **WHEN** een loop span en een child memory span met dezelfde trace id worden opgeslagen
- **THEN** retourneert Djimitflo de spans met parent-child edges
- **AND** markeert Djimitflo spans zonder parent als roots

#### Scenario: Secret-like trace evidence is rejected

- **WHEN** trace evidence een API key, private key, token assignment of secret-like value bevat
- **THEN** weigert Djimitflo de trace span
- **AND** wordt deze evidence niet persistent opgeslagen

### Requirement: Loop checkpoints can branch replay runs safely

Het systeem SHALL loop state kunnen checkpointen en daaruit een replay branch kunnen maken zonder historische worker leases opnieuw actief te maken.

#### Scenario: Checkpoint captures state and historical leases

- **WHEN** een loop-run wordt gecheckpoint
- **THEN** slaat Djimitflo loop status, findings, plan, gates, next actions en worker lease history op
- **AND** blijft het checkpoint read-only bewijs voor latere audit

#### Scenario: Replay branch copies no worker leases

- **WHEN** een checkpoint naar een replay run wordt gebranched
- **THEN** maakt Djimitflo een nieuwe loop-run met status `created`
- **AND** bevat metadata de source checkpoint id
- **AND** worden nul worker leases naar de nieuwe run gekopieerd

### Requirement: Capability tokens enforce least privilege

Het systeem SHALL capability token references uitgeven met expliciete scopes, deny-lists, expiry en approval gates voor high-risk scopes, zonder bearer secrets op te slaan of te tonen.

#### Scenario: Wildcard scope is rejected

- **WHEN** een agent een capability token met scope `*` vraagt
- **THEN** weigert Djimitflo de aanvraag
- **AND** retourneert Djimitflo een scope validation error

#### Scenario: High-risk capability requires approval

- **WHEN** een capability token high of critical risk scope bevat zonder approved_by
- **THEN** weigert Djimitflo de token-aanvraag
- **AND** eist Djimitflo expliciete approval voordat de capability actief wordt

#### Scenario: Token response contains reference only

- **WHEN** een low-risk capability wordt uitgegeven
- **THEN** retourneert Djimitflo een `token_ref`
- **AND** bewaart Djimitflo geen bearer secret in response metadata

### Requirement: Prepared workers can be spawned by the real worker bridge

Het systeem SHALL prepared non-manual maker leases kunnen uitvoeren via een worker spawn bridge die runtime output, artifacts, budget gates, trace spans en checkpoints persistent vastlegt.

#### Scenario: Mock runtime proves the bridge without external CLIs

- **WHEN** een prepared maker lease runtime `mock` heeft
- **THEN** kan Djimitflo `/api/loops/runs/:id/execute-worker` aanroepen
- **AND** gaat de lease via `running` naar `completed`
- **AND** bewaart Djimitflo stdout, stderr, runtime usage, before checkpoint, after checkpoint en worker trace spans

#### Scenario: Codex or OpenCode timeout is failed evidence

- **WHEN** een Codex of OpenCode worker runtime langer loopt dan het configured timeout budget
- **THEN** markeert Djimitflo de worker lease als `failed`
- **AND** markeert Djimitflo de runtime exit gate als failed
- **AND** bewaart Djimitflo timeout, stdout/stderr paths, checkpoints en error trace span voor review

#### Scenario: Dashboard can start a prepared worker

- **WHEN** een loop-run prepared maker leases heeft met runtime Codex, OpenCode of mock
- **THEN** toont het dashboard een run action voor die lease
- **AND** roept de action `/api/loops/runs/:id/execute-worker` aan
- **AND** refreshed het dashboard daarna de review bundle
