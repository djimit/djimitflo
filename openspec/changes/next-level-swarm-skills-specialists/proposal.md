# Next-Level Swarm Skills Specialists

## Why

Djimitflo now has a proved control plane for goals, loop-runs, worker leases, runtime contracts, maker/checker execution, checkpoints, traces, policy-gated runner actions and dashboard visibility.

The next limitation is not "more agents". The next limitation is using many agents without losing operational truth:

- A swarm registry can be healthy while `agentCount = 0` and no work is executing.
- `taskCount`, prepared leases and planned goals are not active worker execution.
- Skill usage must be governed by explicit capability contracts, eval scores and allowed actions.
- Specialist agents are useful only when their claims, dissent, source evidence and follow-up actions are auditable.
- Memory must distinguish claims, evidence, decisions, operational lessons, engineering rules and policy rules.
- Capacity must be planned from workstation runtime signals, not dashboard optimism.

This change models the next functional layer as the **Swarm Intelligence Layer**: a governed capability, specialist, memory and capacity system that can turn questions, hypotheses, repo findings and memory signals into validated goals, queued worker leases and auditable backlog items.

## What Changes

- Define a typed capability registry for skills, specialist agents and runtime adapters.
- Define specialist councils that can reason across domains such as mathematics, biology, physics, psychology, behavioral science, philosophy, security, systems architecture and product strategy.
- Define a hypothesis workbench that turns questions into evidence plans, experiments, dissent and backlog candidates.
- Define an evidence graph and claim ledger for memory-aware reasoning without promoting unverified claims to durable truth.
- Define a capacity governor v2 for queue classes, fair-share scheduling, runtime concurrency, token budget, wall-clock budget, failure budget and kill handling.
- Define an evaluation harness for skills, specialist profiles, memory retrieval, routing decisions and worker outcomes.
- Define a mission-control dashboard view that separates registry state, planned work, prepared leases, running workers, completed work, blocked work and evidence.
- Provide ordered `/goals` payloads so this can be executed as one gated program instead of microsteps.

## Out Of Scope

- No automatic merge, push or deploy.
- No unattended high-risk worker execution.
- No automatic durable memory promotion for policy or security rules.
- No secret, cookie, auth-store or private-token inspection.
- No claim that swarm `agentCount`, registry rows or prepared leases are active execution.
- No dependency on Ruflo as a runtime; Ruflo remains an inspiration/reference pattern while Djimitflo targets Codex/OpenCode workers.

## Success Criteria

- OpenSpec validates strictly.
- `/goals` dry-run emits ordered G14 goals with dependencies.
- Capability contracts exist for skills, specialist profiles and runtimes before they can route work.
- Specialist council output records support, oppose, uncertainty, dissent, evidence references and backlog projection.
- Capacity governor v2 can explain why work is eligible, blocked, queued, running or killed.
- Skill and specialist behavior is evaluated by deterministic harnesses before autonomy expands.
- Dashboard views make active execution provable from runtime evidence only.
