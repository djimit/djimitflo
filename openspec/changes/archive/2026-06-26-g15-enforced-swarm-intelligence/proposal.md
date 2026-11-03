# G15 Enforced Swarm Intelligence

## Why

G14 proved the useful foundation: capability registry, specialist panels, claim ledger, capacity planning, runner manifests and Mission Control visibility. The audit shows the next risk clearly: too much of that intelligence is still advisory.

The 10x improvement is not more screens or more agent labels. It is making the contracts enforce runtime behavior:

- Governance decisions must block or permit `verify`, `complete`, `start-next`, `drain`, `stop`, `kill` and memory promotion.
- Capability contracts must route real workers, not only describe them.
- Evidence must become a graph with resolvable provenance, not strings that can be spoofed.
- Runner manifests must be written automatically by runner actions, not manually posted as theater.
- Capacity planning must become a live scheduler with budgets, fairness, process control and circuit breakers.
- Mission Control must let the operator drill from a visible fact to the evidence that proves it.

This change converts G14 from a strong intelligence/control-plane foundation into an enforced swarm operating layer for Codex/OpenCode workers.

## What Changes

- Repair security boundaries found in G14: OKF path allowlisting, scoped permissions, secret-like payload rejection, runtime node configuration and provenance validation.
- Split candidate capability creation from validated capability promotion.
- Enforce capability routing in worker selection and execution.
- Enforce governance verdicts across loop verification, completion, worker start/drain and memory promotion.
- Replace coarse claim contradiction detection with typed claims and explicit graph relationships.
- Add resolvable evidence provenance for claims, panels, approvals, traces, checkpoints, manifests and memory candidates.
- Make runner manifests automatic, append-only and bound to real loop/lease/action refs.
- Turn Capacity Governor v2 into a live scheduler with queue weights, runtime concurrency, token budget, wall-clock budget, failure budget, stop/kill handling and circuit breakers.
- Sync OKF skills into capability candidates with dry-run-first rebuilds and eval-backed promotion.
- Add hypothesis workbench entities and versioned specialist profile registry.
- Add Mission Control drill-through and gated operator actions.
- Add an end-to-end scenario smoke that proves the chain from specialist reasoning to mock worker execution to dashboard evidence, followed by bounded Codex/OpenCode smokes.

## Out Of Scope

- No automatic merge, push or deploy.
- No unattended high-risk execution.
- No automatic durable memory promotion for policy, security, auth, deploy or autonomy rules.
- No inspection or persistence of secrets, cookies, password stores or private tokens.
- No dependency on Ruflo as a runtime. Ruflo remains an inspiration/reference pattern; Djimitflo targets Codex/OpenCode workers.
- No claim that registry rows, prepared leases, `agentCount`, `taskCount` or dashboard actions are active execution without runtime evidence.

## Success Criteria

- OpenSpec validates strictly.
- `/goals` dry-run emits the ordered G15 goals and dependency graph.
- G14 high findings are closed by tests: OKF path escape, spoofed governance verdict, spoofed runner manifest and false claim contradiction.
- Capability threshold failures are hard failures, not score dilution.
- `startNextWorker` and `drainWorkerPool` select workers only through validated capability contracts.
- `verifyLoopRun`, `completeLoopRun`, worker start/drain and memory promotion call the governance enforcement layer.
- Runner manifests are auto-written for plan, start, skip, stop, kill, timeout, failure and completion.
- Capacity scheduler enforces queue fairness, concurrency, token/wall-clock/failure budgets and kill handling.
- Mission Control can drill from a dashboard metric to the backing capability, claim, panel, backlog item, goal, loop, lease, trace, checkpoint, manifest or memory candidate.
- End-to-end mock scenario proves the complete evidence chain before bounded real Codex/OpenCode smokes.
