## ADDED Requirements

### Requirement: Swarm intelligence enforces security boundaries before persistence or routing

Djimitflo SHALL validate paths, permissions, sensitive payloads, runtime node identity and evidence refs before data can influence routing, memory, backlog or dashboard actions.

#### Scenario: OKF root cannot escape configured roots

- **WHEN** an OKF drift or sync request references a root
- **THEN** Djimitflo resolves the root to a canonical real path
- **AND** accepts it only when it is within a configured OKF root or workspace root
- **AND** rejects arbitrary filesystem paths

#### Scenario: Scoped permissions replace broad task creation

- **WHEN** a caller writes capabilities, claims, governance decisions, runner manifests or swarm actions
- **THEN** Djimitflo requires the matching scoped permission
- **AND** refuses the write when the caller only has generic task creation permission

#### Scenario: Secret-like payloads are rejected safely

- **WHEN** a claim, evidence payload, trace payload, runner manifest or memory candidate contains secret-like content
- **THEN** Djimitflo rejects persistence of the sensitive value
- **AND** stores only a safe rejection event with no secret material

#### Scenario: Runtime node labels come from inventory

- **WHEN** Mission Control reports cockpit or execution-node state
- **THEN** Djimitflo uses runtime config or heartbeat-derived inventory
- **AND** does not hardcode MacBook or workstation identity in service logic

### Requirement: Capability promotion is evidence-backed and router-enforced

Djimitflo SHALL separate capability candidate creation from validated promotion and use only validated eligible capabilities for live worker routing.

#### Scenario: Candidate capability cannot route workers

- **WHEN** a capability has status `draft` or `candidate`
- **THEN** Djimitflo may use it for dry-run or advisory planning
- **AND** refuses live worker routing through that capability

#### Scenario: Capability promotion requires proof

- **WHEN** a capability is promoted to `validated`
- **THEN** Djimitflo requires owner, version, allowed actions, forbidden actions, risk ceiling, eval threshold, removal strategy, eval scorecard refs and evidence refs
- **AND** records the promotion actor and approval refs

#### Scenario: Eval threshold miss is a hard failure

- **WHEN** a capability eval score is below its configured threshold
- **THEN** Djimitflo marks capability evaluation failed
- **AND** blocks live routing even if other checklist fields pass

#### Scenario: Worker selection uses capability contracts

- **WHEN** `startNextWorker` or worker drain selects a lease
- **THEN** Djimitflo selects only a runtime and skill path backed by validated capability contracts
- **AND** records blocked reasons for ineligible capabilities

### Requirement: Governance verdicts are enforced from persisted evidence refs

Djimitflo SHALL compute enforceable governance decisions from persisted refs rather than trusting request-supplied pass/fail booleans.

#### Scenario: Spoofed governance payload is refused

- **WHEN** a caller submits maker, checker, security, quorum or human approval booleans
- **THEN** Djimitflo treats them as advisory input only
- **AND** resolves persisted evidence refs before allowing any mutating action

#### Scenario: Governance gates block loop completion

- **WHEN** a loop completion lacks required checker, security checker, quorum or human approval refs
- **THEN** Djimitflo blocks completion
- **AND** leaves `ready_for_human_merge`, `human_approved` and `completed` as distinct states

#### Scenario: Governance gates block worker pool actions

- **WHEN** a worker start, drain, stop or kill action is requested
- **THEN** Djimitflo evaluates action, actor, risk, capability, capacity, budget and policy refs
- **AND** allows, blocks or requires human approval before the runner mutates state

#### Scenario: Governance gates block memory promotion

- **WHEN** a memory candidate affects policy, security, auth, deploy, production or autonomy behavior
- **THEN** Djimitflo requires human review refs before promotion
- **AND** blocks automatic durable memory promotion

### Requirement: Claim ledger v2 uses typed claims and explicit relationships

Djimitflo SHALL store typed claims with resolvable evidence and explicit support, refinement or contradiction relationships.

#### Scenario: Claim requires typed proof fields

- **WHEN** a claim is recorded
- **THEN** the claim includes subject ref, predicate, object, scope, confidence, validity window, status, source ref, sensitivity and evidence refs
- **AND** unsupported claims remain `proposed`

#### Scenario: Same subject is not automatically contradiction

- **WHEN** two supported claims share a subject
- **THEN** Djimitflo does not mark them contradictory unless predicate/object/scope rules or explicit contradiction refs require it

#### Scenario: Evidence refs must resolve before influence

- **WHEN** a claim influences routing, backlog priority, dashboard decisions or memory promotion
- **THEN** every required evidence ref resolves to an allowed persisted record kind
- **AND** unresolved refs block influence

#### Scenario: Specialist review extracts proposed claims

- **WHEN** a specialist panel review contains claims
- **THEN** Djimitflo extracts typed proposed claims with panel and review refs
- **AND** requires separate evidence support before promotion

### Requirement: Evidence graph resolves end-to-end lineage

Djimitflo SHALL connect panels, claims, backlog items, goals, loops, leases, traces, checkpoints, manifests and memory candidates into a permission-filtered lineage graph.

#### Scenario: Operator can trace panel to memory candidate

- **WHEN** a memory candidate originates from specialist analysis
- **THEN** Djimitflo can resolve lineage from memory candidate to runner manifest, checkpoint, trace, worker lease, loop run, goal, backlog item, claim, review and panel when those edges exist

#### Scenario: Operator can reverse lookup from lease

- **WHEN** an operator inspects a worker lease
- **THEN** Djimitflo can show the goal, loop, capability, capacity decision, governance decision, manifests, trace spans and claims connected to that lease

#### Scenario: Lineage output respects permissions

- **WHEN** a caller lacks permission for part of the evidence graph
- **THEN** Djimitflo omits or redacts that node
- **AND** does not leak existence of restricted sensitive records through labels or counts

### Requirement: Runner manifests are automatic, append-only runtime evidence

Djimitflo SHALL write runner manifests from runner action paths and reject direct assertion of completed runner facts.

#### Scenario: Runner writes action manifests automatically

- **WHEN** the runner plans, starts, skips, stops, kills, times out, fails, completes or summarizes a drain
- **THEN** Djimitflo writes an append-only manifest with action, actor, loop-run id, lease id when applicable, enforcement decision, capacity snapshot, budget snapshot and trace refs

#### Scenario: Direct manifest spoofing is refused

- **WHEN** a caller tries to directly create a completed start, completion, failure or kill manifest through a public API
- **THEN** Djimitflo refuses the write
- **AND** requires the corresponding runner action path to create it

#### Scenario: Runtime artifacts are attached

- **WHEN** a worker run produces stdout, stderr, artifacts, parsed usage, checkpoints or trace spans
- **THEN** Djimitflo attaches refs to the runner manifest
- **AND** preserves before and after checkpoint refs for execution actions

### Requirement: Capacity governor live scheduler enforces queue, budget and circuit breaker policy

Djimitflo SHALL schedule prepared leases using queue fairness, runtime capacity, budgets, failure history and stop/kill controls.

#### Scenario: Fair-share scheduling selects eligible work

- **WHEN** multiple queue classes contain eligible prepared leases
- **THEN** Djimitflo selects work according to configured fair-share weights, queue age and starvation protection
- **AND** records selected and skipped reasons

#### Scenario: Budgets block worker start

- **WHEN** token, wall-clock, retry, failure or concurrency budget is exhausted
- **THEN** Djimitflo blocks worker start
- **AND** records the budget snapshot and blocked reason in trace and manifest evidence

#### Scenario: Stop and kill preserve evidence

- **WHEN** a worker exceeds timeout, budget, failure policy or explicit stop request
- **THEN** Djimitflo stops or kills through the runtime adapter
- **AND** records stdout, stderr, exit reason, artifacts, trace span, checkpoint and manifest refs

#### Scenario: Fleet circuit breaker prevents repeated failure loops

- **WHEN** repeated maker failures, checker rejections, runtime warnings or timeouts exceed configured thresholds
- **THEN** Djimitflo blocks additional drain for the affected queue, capability or runtime
- **AND** requires governance review before resuming

### Requirement: OKF skill sync and hypothesis workbench feed governed capability and backlog flow

Djimitflo SHALL index configured OKF skills into capability candidates and model hypotheses before creating goals or worker leases.

#### Scenario: OKF sync is dry-run by default

- **WHEN** Djimitflo scans configured OKF skill roots
- **THEN** it produces candidate capability changes as a dry-run
- **AND** requires explicit scoped apply permission before registry mutation

#### Scenario: Validated skills become route-eligible

- **WHEN** a synced skill has contract metadata, eval scorecard refs and approval evidence above threshold
- **THEN** Djimitflo may promote it to validated
- **AND** it becomes route-eligible only within its risk ceiling and allowed actions

#### Scenario: Specialist profile version is persisted

- **WHEN** a specialist panel review is created
- **THEN** Djimitflo stores the specialist profile id and version used for that review

#### Scenario: Hypothesis requires falsification and stop condition

- **WHEN** a hypothesis is created from a question, panel or finding
- **THEN** Djimitflo stores evidence plan, falsification signal, stop condition and owner capability
- **AND** creates no worker lease until a governed backlog or goal action is approved

### Requirement: Mission Control exposes drill-through and gated actions

Djimitflo SHALL make swarm state actionable through evidence-backed drill-through and enforcement-gated actions.

#### Scenario: Dashboard drills into evidence

- **WHEN** an operator selects a metric, claim, capability, panel, backlog item, goal, loop, lease, trace, checkpoint, manifest or memory candidate
- **THEN** Mission Control opens the corresponding evidence-backed detail view or graph path

#### Scenario: Dashboard actions are enforcement-gated

- **WHEN** an operator requests capability promotion, claim resolution, panel projection, goal creation, start-next, drain, stop, kill or manifest review
- **THEN** Djimitflo obtains an enforcement decision
- **AND** disables or blocks the action with exact reasons when the decision is not allow

#### Scenario: Active execution label requires runtime evidence

- **WHEN** the dashboard displays active worker execution
- **THEN** the value is derived from runtime evidence such as runtime session id, pid, trace span, checkpoint or artifact refs
- **AND** registry rows, prepared leases, `agentCount` and `taskCount` are displayed separately

### Requirement: End-to-end scenario proves non-theater swarm enforcement

Djimitflo SHALL prove the enforced swarm path with a mock runtime before bounded real Codex/OpenCode smokes.

#### Scenario: Mock runtime proves full chain

- **WHEN** the end-to-end scenario runs with mock runtime
- **THEN** it creates a question, hypothesis, specialist panel, typed claims, backlog item, goal, prepared lease, scheduler plan, worker run, checker result, runner manifests, trace spans, checkpoints, memory candidate and dashboard proof
- **AND** every mutating step has an enforcement decision

#### Scenario: Real runtime smoke is bounded

- **WHEN** the mock scenario is green
- **THEN** Djimitflo may run bounded Codex and OpenCode smokes
- **AND** records stdout, stderr, artifacts, parsed usage, budgets, trace spans, checkpoints and remaining risks

#### Scenario: Smoke never performs forbidden production actions

- **WHEN** an end-to-end scenario or real runtime smoke runs
- **THEN** Djimitflo performs no merge, push, deploy, high-risk unattended execution or automatic policy memory promotion
