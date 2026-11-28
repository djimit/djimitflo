# ADR 0004: Commons signal-to-goal bridge — a connection, not a new subsystem

Status: proposed 2026-11-28 (PR #1379). Default off; not active anywhere.

## Context

Verified on 2026-11-28 against `origin/main` and production (`20fedc33`, `GET /api/health`: healthy, `commit_matches_build`
true, instance `vps-agentical-production`):

- The chain failure → Commons thread → learning → proposal → grounding → panel → approval → goal → project room → maker /
  checks / checker already exists, piece by piece, each behind its own flag. In production the failure agenda, the
  grounding agenda, grounding apply and proposal review are off, the project room mode is unset, and investigation,
  falsifier and skill route run in shadow.
- Only loop failures could become a Commons topic. Failed leases, skill outcomes, rejected memory candidates, project-room
  calls and unanswered Commons questions had no route into a discussion.
- A goal did not say which signal it came from.
- What a run proved was spread over the lease, the task, execution events, the skill route receipt and the run; nothing
  stated in one place whether an outcome was independently verified.
- The lease cleanup fails a hung lease after `DJIMFLO_STALE_RUNNING_THRESHOLD_HOURS`; its execution task kept status `running`.

## Decision

One file connects the existing records to the existing paths, behind `COMMONS_SIGNAL_BRIDGE_MODE = off | shadow | on`
(`packages/server/src/services/commons-signal-bridge.ts`), and one file projects a receipt
(`packages/server/src/services/execution-receipt.ts`). Nothing else is added: no scheduler loop of its own beyond one
registered 15-minute tick, no registry, no message store, no memory store, no trace store, no model call.

| Step | Owner (unchanged) | What the bridge adds |
|---|---|---|
| signal card | `judgments` | one `commons_signal` row per signature, window and mode, with evidence refs that resolve to rows |
| discussion | `AgentCommunicationService.socialize` / `agent_messages` | a card as third work topic (`topic_ref signal:<signature>`, `params.signal_signature`) |
| proposal, grounding, panel, approval | `SelfImprovementService`, `commons-grounding.ts`, specialist panel | nothing |
| goal | `AutonomousGoalGenerator` | `metadata.commons_signal`; an extra refusal for an ungrounded or protected signal proposal |
| project room | `project-room.ts` | `task_profile = 'project_room'` only with `COMMONS_SIGNAL_PROJECT_ROOM=on`, after the gate |
| maker, checks, checker, budgets, leases, retries, cancel | loop daemon, lease repo, execution engine | nothing |
| verification | checker lease + daemon check exit codes | the receipt reads them; it decides nothing about the run |
| memory / skill candidate | `MemoryCandidateService` (review-gated), capability registry | one candidate per settled signal goal, only as the receipt allows |
| promotion, merge | existing promotion review, `scripts/merge-train.sh` | nothing |

### Patterns taken from other systems

No code, schema or dependency was copied; these are design rules, so there is no upstream commit or licence to track.
Read on 2026-11-28:

| Pattern | Source | Where it is used |
|---|---|---|
| A resumed step may run again: check for an existing result before writing | LangGraph functional API — https://docs.langchain.com/oss/python/langgraph/functional-api | card, goal-gate, outcome and stale-trace records are written once per key |
| No exactly-once side effects: reconcile uncertain ones | OpenAI Agents SDK, human-in-the-loop — https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/human-in-the-loop.mdx | a stale task is held with outcome `unknown`, never replayed |
| A fresh reviewer, independence enforced by the harness | Claude Code sub-agents / best practices — https://code.claude.com/docs/en/sub-agents | `verified` needs a checker lease other than the maker |
| Proposed memory, second review, then commit | Letta memory — https://docs.letta.com/configuration/memory | candidates only; Djimitflo adds a human gate Letta does not have |
| Terminate and resume instead of a blocked run | AutoGen human-in-the-loop — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/human-in-the-loop.html | a refused gate parks the proposal; nothing waits |

Not adopted: checkpointers, sessions, MemFS, group-chat runtimes, event stores, trace exporters (each would duplicate an
existing Djimitflo layer). The OpenHands stuck detector and condenser were read and not built. None of the six sources
publishes a full run-state enum; the lifecycle below is Djimitflo's own.

## Capability inventory

| Capability | Where | Mode |
|---|---|---|
| collect recurring records into cards | `collectSignals` | shadow, on |
| record cards idempotently | `recordSignalCards` | shadow, on |
| offer a card to the Commons round | `pickSignalTopic` | on |
| trace a proposal back to its signal | `signalOrigin` | shadow, on |
| goal gate and goal source metadata | `signalGoalDecision` | shadow records, on acts |
| project-room route and rollback | `signalGoalDecision`, `rollbackToDirectRoute` | on + `COMMONS_SIGNAL_PROJECT_ROOM=on` |
| execution receipt, trace lifecycle | `executionReceipt`, `runReceipt`, `traceLifecycle` | read-only, always available |
| outcome → candidate | `recordSignalOutcome` | shadow records, on creates |
| stale running tasks | `sweepStaleTraces` | shadow records, on holds |
| board view | `GET /api/swarm-v2/commons-signals` (`read:evidence`) | read-only |

## Flags

| Flag | Default | Values |
|---|---|---|
| `COMMONS_SIGNAL_BRIDGE_MODE` | off | `shadow`: judgments only. `on`: topic, goal metadata, gate, hold, candidates |
| `COMMONS_SIGNAL_PROJECT_ROOM` | off | `on`: a gated signal goal selects the project room, when `COMMONS_PROJECT_ROOM_MODE` is not off |

Both are in `EVOLUTION_FLAGS`, `fitness-contracts.ts`, the runbook flag table and the env inventory. Any other value is off.

## Evidence contract

- A card: `{version, signature, source, kind, title, count, first_seen, last_seen, evidence_refs, status: 'hypothesis',
  disposition}`. `signature = sha256(source, kind)`; a kind needs at least 2 records in 7 days.
- `kind` and `title` are built from identifiers and enum values (role, runtime, failure stage, stderr class, skill id,
  memory type, profile, error code); every other character is replaced. Free text and secrets from a failing process or an
  agent cannot reach a card or a prompt.
- An evidence ref is `<prefix>:<id>` with a prefix from a fixed table (`lease`, `run`, `skill_outcome`, `memory_candidate`,
  `project_room_call`, `message`, `task`) and must resolve to a row. Refs that do not resolve are dropped.
- Dispositions: `card` (may be discussed in `on`), `insufficient_evidence` (never discussed), `operator_only` (auth,
  secret, token, credential, deploy: never discussed).
- A card stays a hypothesis. A row written in shadow is never acted on; after a switch to `on` the kind is recorded again.

## Receipt contract

`executionReceipt(db, leaseId)` returns, with `null` for anything not observed:

`lease_id, run_id, role, lease_status, capability_id, source_revision, skill_hash, runtime_requested, runtime_observed,
model, trace {task_id, state, attempts, admitted_event_runtime, last_event_at, reason}, verification {run_status, checks,
checker_lease_id, checker_verdict, independent}, verdict, reasons`.

- `runtime_observed` is the executor kind on the engine's own `admitted` event. Requested runtime and model alone are not
  proof that a model ran.
- Trace states: `prepared, admitted, started, interrupted, resumed, completed, failed, cancelled, unknown`. `unknown` covers
  no task, a running task without an admission, a running task with no event inside the stale threshold, and a restart or
  stale hold whose external outcome nobody observed.
- `verified` requires all of: lease completed, trace completed, observed runtime, at least one check and every check
  exit 0, a completed checker lease other than the maker that names this maker with verdict `accepted`, and a run in
  `completed` or `ready_for_human_merge`. An observed failure is `failed`. Everything else is `unknown`.

## Use

1. Shadow: set `COMMONS_SIGNAL_BRIDGE_MODE=shadow` and recreate the container. Read `GET /api/swarm-v2/commons-signals`
   and the `commons_signal*` judgments. Nothing is posted, created or changed.
2. On (operator decision, after shadow data): set `on`. Cards appear as Commons topics after the failure and grounding
   agendas; proposals follow the existing path; goals from a signal carry `metadata.commons_signal`.
3. Project room for signal goals (optional): `COMMONS_SIGNAL_PROJECT_ROOM=on` with `COMMONS_PROJECT_ROOM_MODE` not off.

## Rollback

- The bridge: set `COMMONS_SIGNAL_BRIDGE_MODE=off` and recreate the container. No card, goal or candidate is removed;
  goals keep their metadata; candidates stay in review.
- One goal back to the direct route: `POST /api/swarm-v2/project-rooms/:goalId/select {"selected": false}`.
- A task held by the stale sweep: the same operator reconciliation as a restart hold (`execution_recovery_hold`).
- A capability version: the bridge registers and promotes none. A how-to candidate that becomes a skill goes through the
  capability registry, whose versions are immutable; the previous validated version stays selectable when a newer one is
  set `deprecated` (`swarm_capabilities.status`).
- The code: revert the PR. There is no migration.

## Evidence

| Level | State on 2026-11-28 |
|---|---|
| source | branch `feat/commons-signal-bridge`, PR #1379 |
| tests | `commons-signal-bridge.test.ts`: fails on `origin/main` (`Cannot find module '../services/execution-receipt'`), passes on the branch |
| CI | green on the PR head, Node 22 and 24 |
| local | server booted on a temporary database in `shadow`: health 200, endpoint 401 without and 200 with a session; three seeded failed leases gave one card on the first tick, none on the second, and no goal, message or candidate |
| deployed | no |
| healthy in production | not applicable; production runs `20fedc33` without this change |
| browser-verified | no; there is no dashboard view |
| real model run | none. No Commons resident, maker or checker ran against a signal card |

## Limits

- `metadata.source` stays `self-improvement` because `objective-loop-gate.ts` reads it; the signal source is
  `metadata.commons_signal.source = 'commons_signal'`.
- A signature is discussed once. A kind that recurs after its goal settled gets a new card and no second thread.
- The stale sweep does not consult the engine's in-memory session. A task without a lease that is silent for longer than
  the threshold would be held in `on`. Measure the shadow records before switching on.
- The shadow pilot ran on seeded local data, not on production records.
- No dashboard tab and no OpenSpec change.
