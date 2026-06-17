# Commit, Workstation Smoke And Policy Runner

## Why

`real-worker-fleet-functionality-scale` made the control plane materially stronger: maker/checker execution, runtime contracts, evidence artifacts, `ready_for_human_merge`, fleet-pool status, dashboard controls and opt-in backlog-to-lease preparation are implemented and validated locally.

The next risk is operational, not architectural:

- The worktree still contains unrelated dirty/untracked env files from earlier work.
- A commit must preserve the scoped implementation without staging unrelated local artifacts.
- The MacBook dashboard may observe/control, but the workstation is the execution node, so live proof must target the workstation runtime surfaces.
- The last smoke used `mock` runtime intentionally; the next proof must run actual Codex/OpenCode adapters with strict budgets and no merge.
- A policy-gated worker pool runner should only be built after runtime evidence is current.

## What Changes

- Define a selective commit gate for the real-worker/fleet scope.
- Define workstation live smoke checks for API, dashboard, runtime contracts, swarm status and prepared leases.
- Define real Codex/OpenCode smoke tests with temp DB/temp repo, hard timeout, token budget and artifact verification.
- Define the policy-gated worker pool runner design and acceptance gates.
- Provide ordered `/goals` payloads so the work can be registered and executed as one planned sequence.

## Out Of Scope

- No automatic merge, push or deploy.
- No automatic worker execution during `/goals` creation.
- No secrets inspection, cookie mining or auth-store scraping.
- No unattended high-risk worker execution.
- No scale claims without current runtime, queue and resource evidence.

## Success Criteria

- A scoped commit exists for the validated real-worker/fleet work.
- `git status` after commit clearly separates committed scope from unrelated dirty/untracked local files.
- Workstation live smoke proves `/api/loops/runtime-contracts`, `/api/swarms/status`, dashboard Fleet Cockpit and Goals/Loops worker actions are reachable.
- Real Codex and OpenCode smoke runs either complete with artifacts/gates/token usage or fail with actionable runtime contract evidence before spawn.
- Policy-gated runner can start only allowed prepared workers under runtime availability, resource capacity, risk class, token budget and human approval policy.
- All new OpenSpec artifacts validate strictly.
