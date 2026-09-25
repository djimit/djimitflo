## ADDED Requirements

### Requirement: Swarm intelligence distinguishes registry, planning and active execution

Djimitflo SHALL report swarm registry state, planned work, prepared leases, running workers and completed work as separate operational facts.

#### Scenario: Registry agent count is not active execution

- **WHEN** a swarm bridge reports `agentCount = 0`
- **AND** Djimitflo has prepared worker leases
- **THEN** Djimitflo reports zero active swarm agents for that bridge
- **AND** reports prepared leases separately
- **AND** does not present prepared leases as running workers

#### Scenario: Active execution requires runtime evidence

- **WHEN** a worker lease is marked `running`
- **THEN** Djimitflo requires runtime evidence such as pid, runtime session id, artifact path, trace span or checkpoint
- **AND** excludes leases without runtime evidence from `active_execution_count`

### Requirement: Capability registry governs skills, specialists and runtimes

Djimitflo SHALL route work through typed capability contracts before skills, specialist agents or runtime adapters can influence live execution.

#### Scenario: Skill registry requires operational contract

- **WHEN** Djimitflo indexes a project skill
- **THEN** the registry record includes skill id, OKF path, status, trust level, allowed actions, forbidden actions, gates, escalation and latest validation report path
- **AND** registration fails when a skill only has descriptive text but lacks actions or gates

#### Scenario: Draft capability cannot start workers

- **WHEN** a capability has status `draft` or `candidate`
- **THEN** Djimitflo may use it for planning, dry-run or advisory output
- **AND** refuses to route live worker execution through that capability

#### Scenario: Capability contract includes removal strategy

- **WHEN** a capability is registered
- **THEN** its contract includes allowed actions, forbidden actions, required evidence, risk ceiling, eval threshold and removal strategy
- **AND** Djimitflo refuses registration when those fields are missing

#### Scenario: Low eval score blocks routing

- **WHEN** a validated capability falls below its configured eval threshold
- **THEN** Djimitflo blocks new routing through that capability
- **AND** records the blocked reason in trace evidence

### Requirement: Specialist councils produce bounded auditable decisions

Djimitflo SHALL support specialist panels with bounded profiles, independent reviews, consensus, dissent and backlog projection.

#### Scenario: Specialist profile is versioned

- **WHEN** a specialist profile is loaded
- **THEN** Djimitflo records profile id, version, required evidence, forbidden claims, risk gates and output schema
- **AND** panel results retain the profile version used for each review

#### Scenario: Unknown specialist profile is rejected

- **WHEN** a panel request references an unknown specialist id
- **THEN** Djimitflo rejects the panel request
- **AND** records no advisory decision for that unknown profile

#### Scenario: High-risk panel requires security reviewer

- **WHEN** a specialist panel has risk class `high` or `critical`
- **THEN** Djimitflo requires `security_reviewer` in the panel
- **AND** refuses panel start when that specialist is missing

#### Scenario: Consensus preserves dissent

- **WHEN** specialist reviews include support, oppose, uncertain and needs_evidence verdicts
- **THEN** Djimitflo stores each independent review
- **AND** computes consensus counts without deleting dissent
- **AND** marks the panel `consensus_ready` only after required profiles have submitted

#### Scenario: Panel can create backlog without starting workers

- **WHEN** a consensus-ready panel projects a valuable next action
- **THEN** Djimitflo creates a backlog work item with panel id, decision, confidence, dissent summary and evidence refs
- **AND** creates zero worker leases during that projection

#### Scenario: Backlog projection carries proof obligations

- **WHEN** a panel, reflection, eval failure or loop finding projects backlog
- **THEN** the work item metadata includes value, risk, confidence, recommended loop, required gates and missing evidence
- **AND** `needs_more_evidence` findings remain candidate instead of triaged

### Requirement: Hypothesis workbench turns questions into evidence plans

Djimitflo SHALL convert broad questions into bounded hypotheses, evidence plans, experiments and decisions before execution.

#### Scenario: Hypothesis requires evidence plan

- **WHEN** an operator submits a research or architecture question
- **THEN** Djimitflo creates at least one hypothesis with expected evidence, falsification signal, stop condition and owner capability
- **AND** does not create worker leases until a backlog item or goal is explicitly approved

#### Scenario: Unsupported claim cannot become durable memory

- **WHEN** a specialist output contains a claim without source reference or evidence link
- **THEN** Djimitflo stores the claim as `proposed`
- **AND** blocks promotion to durable memory until evidence is attached or the claim is rejected

### Requirement: Evidence graph and claim ledger preserve reasoning state

Djimitflo SHALL persist claims, evidence, decisions, memory candidates and trace relationships as an auditable graph.

#### Scenario: Ledger claim carries proof fields

- **WHEN** Djimitflo records a claim
- **THEN** the ledger entry includes claim text, claim type, subject ref, evidence refs, confidence, status, verified-by gate, invalidated-by ref and created-from ref
- **AND** no backlog, goal, skill or memory promotion is allowed from free text alone

#### Scenario: Claim contradiction is visible

- **WHEN** a new claim conflicts with an existing supported claim
- **THEN** Djimitflo links the claims as contradictory
- **AND** marks the new decision state as `needs_evidence` or `review_required`

#### Scenario: Policy memory requires human review

- **WHEN** a memory candidate changes policy, autonomy, auth, approval, deploy, production or security behavior
- **THEN** Djimitflo classifies it as `policy_rule`
- **AND** marks it `review_required`
- **AND** blocks automatic promotion

#### Scenario: Secret-like evidence is rejected

- **WHEN** evidence, claim text, trace payload or memory candidate contains secret-like content
- **THEN** Djimitflo rejects persistence of that payload
- **AND** stores only a safe rejection event without the secret-like value

#### Scenario: Memory ingestion uses governed stages

- **WHEN** a memory candidate is created from a panel, loop, trace, eval or reflection
- **THEN** it moves through candidate, classified, reviewed or promoted, and sink projection stages
- **AND** OKF remains the canonical durable source while Qdrant or UAMS are treated as projections

#### Scenario: OKF drift report is reproducible

- **WHEN** Djimitflo checks OKF drift
- **THEN** the report compares project knowledge files, configured OKF base, DB registry records and derived search indexes
- **AND** lists missing indexes, path mismatches and stale trust levels
- **AND** rebuild is dry-run by default

### Requirement: Capacity governor v2 schedules by queue class, budget and workstation truth

Djimitflo SHALL use workstation resource signals, runtime contracts, queue classes and budgets to decide which prepared work can run.

#### Scenario: Plan explains eligible and blocked work

- **WHEN** the capacity governor plans a runner tick
- **THEN** it groups leases by queue class, runtime, risk and age
- **AND** marks each lease eligible or blocked
- **AND** includes policy, runtime, capacity, token, wall-clock, failure-budget or gate reasons for blocked leases

#### Scenario: Fair-share prevents one queue from starving others

- **WHEN** multiple queue classes contain eligible low-risk work
- **THEN** the governor chooses work using configured fair-share weights
- **AND** records the selected queue class and reason in trace spans

#### Scenario: Kill handling produces evidence

- **WHEN** a running worker exceeds timeout, budget or explicit stop request
- **THEN** Djimitflo kills or stops the worker through the runtime adapter
- **AND** writes stdout, stderr, exit reason, trace span and after-checkpoint evidence
- **AND** marks the lease `failed`, `killed` or `blocked` according to configured policy

### Requirement: Evaluation harness validates skills, specialists, memory and routing

Djimitflo SHALL evaluate capabilities and decisions before expanding autonomy or routing live work.

#### Scenario: Skill contract eval blocks invalid skill

- **WHEN** a skill contract lacks required fields, exceeds its risk ceiling or fails schema validation
- **THEN** the eval harness marks the capability as failed
- **AND** Djimitflo refuses live routing through that skill

#### Scenario: Specialist output eval detects unsupported claims

- **WHEN** a specialist review contains claims without evidence refs
- **THEN** the eval harness records unsupported claim count
- **AND** blocks consensus promotion when unsupported claims exceed threshold

#### Scenario: Dashboard truth eval catches misleading metrics

- **WHEN** dashboard data labels registry agents or prepared leases as active execution
- **THEN** the eval harness fails the dashboard truth check
- **AND** records the affected metric and expected label

#### Scenario: Eval scorecards avoid hidden external writes

- **WHEN** an eval suite runs for memory, skill, specialist profile, claim ledger, backlog item or loop target
- **THEN** the scorecard includes concrete counts and checks
- **AND** defaults `external_writes` to zero
- **AND** blocks promotion when score is below threshold

### Requirement: Mission Control dashboard exposes next safe action

Djimitflo SHALL expose a mission-control dashboard that makes swarm state, capacity, skills, specialist councils, claims and next safe actions visible.

#### Scenario: Operator sees workstation execution truth

- **WHEN** the dashboard is opened from the MacBook
- **THEN** it labels the MacBook as cockpit when applicable
- **AND** labels the workstation as execution node when worker runtime evidence comes from the workstation
- **AND** does not imply local browser activity is worker execution

#### Scenario: Operator sees capability health

- **WHEN** the operator opens the skill catalog
- **THEN** Djimitflo shows capability status, eval score, risk ceiling, allowed actions, blocked reason and latest evidence
- **AND** disables live-run actions for non-validated or blocked capabilities

#### Scenario: Operator sees decision lineage

- **WHEN** a backlog item was projected from a specialist panel
- **THEN** the dashboard links from backlog item to panel, reviews, dissent, evidence refs, claims and generated goal
- **AND** shows whether any worker lease has started

### Requirement: Decision governance harness enforces fleet-scale closure rules

Djimitflo SHALL enforce evaluator quorum, split-decision eligibility, audit manifests, replay lineage, runtime warning gates, circuit breakers and human approval semantics before closure.

#### Scenario: Evaluator quorum is a hard gate

- **WHEN** high-risk or disputed work has maker, checker and security checker pass evidence
- **AND** the required evaluator quorum is missing
- **THEN** Djimitflo keeps the loop blocked
- **AND** records missing quorum evidence in the gates

#### Scenario: Split decision requires policy eligibility

- **WHEN** an operator or agent requests task splitting
- **THEN** Djimitflo permits split only when finding metadata marks the task too large, repeated failure threshold is reached, or checker verdict includes `split_recommended`
- **AND** split creates child findings without worker leases
- **AND** the parent finding cannot be directly assigned after split

#### Scenario: Runner decision writes audit manifest

- **WHEN** the worker pool runner starts, skips, fails, stops or kills a lease
- **THEN** Djimitflo writes an audit manifest with decision id, policy version, runtime contract status, capacity snapshot, budget snapshot, gate refs and blocked reasons
- **AND** review bundles can retrieve that manifest

#### Scenario: Replay branch does not copy worker leases

- **WHEN** a checkpoint is branched for replay
- **THEN** the replay run references the source checkpoint id
- **AND** starts with zero worker leases
- **AND** treats historical artifacts as read-only evidence

#### Scenario: Runtime warnings become risk-aware gates

- **WHEN** runtime warnings appear during worker execution
- **THEN** low-risk plugin or session warnings may remain advisory
- **AND** high-risk trust-boundary or runtime-contract warnings fail the runtime warning gate unless accepted by explicit security or human approval

#### Scenario: Fleet circuit breaker stops repeated failure loops

- **WHEN** repeated maker failures, checker rejections or runtime timeouts exceed configured threshold across a loop or fleet pool
- **THEN** Djimitflo blocks further drain for the affected class
- **AND** preserves stdout, stderr, diff, checkpoint and trace evidence

#### Scenario: Merge-ready is not completed

- **WHEN** mutating work reaches `ready_for_human_merge`
- **THEN** Djimitflo does not mark it `completed` until a human approval record or applicable non-mutating closure policy exists
- **AND** dashboard and API distinguish `ready_for_human_merge`, `human_approved` and `completed`
