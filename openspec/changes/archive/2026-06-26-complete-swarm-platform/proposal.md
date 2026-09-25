# Complete Swarm Platform

## Why

Djimitflo's critical path has five incomplete OpenSpec changes with 256
unchecked tasks across them:

| Change | Unchecked | Focus |
|--------|-----------|-------|
| g15-enforced-swarm-intelligence | 51 | Enforcement: security boundaries, capability promotion, governance, claim ledger v2, evidence resolver, auto-manifests, capacity scheduler, OKF sync, Mission Control drill-through |
| g16-no-theater-swarm-proof | 64 | Proof: runtime contract repair, enforcement repair, OpenCode health, OpenAI descriptors, proof run service, proof API/CLI, Mission Control proof, live smoke |
| next-level-swarm-skills-specialists | 40 | G14 tasks (already implemented via converge, need checkbox closure) |
| add-pi-executor | 17 | Pi executor: JSON event mapping, e2e sovereign run, docs |
| add-pi-loop-runtime | 32 | Pi as loop runtime: union sites, contract probe, args, usage parsing |
| agentic-control-loop-fleet | 9 | Loop fleet: docs, contract capture, resume, skill validation |
| commit-workstation-smoke-and-policy-runner | 43 | Workstation deployment: commit, deploy, verify, smoke |

This change consolidates all remaining work into one executable program with
ordered goals, clear dependencies, and a single validation gate. Each goal
maps to specific tasks in the source changes, so progress is traceable.

## What Changes

### Phase 1 — G14 Closure
Check off all 40 `next-level-swarm-skills-specialists` tasks — they are
already implemented and tested via `converge-foundation-and-swarm-intelligence`.
The tables, services, tests and dashboard views exist; the tasks just need
evidence-based checkbox closure.

### Phase 2 — G15 Enforcement (remaining 51 tasks)
- Security boundary: OKF path allowlisting, scoped permissions, secret-like detector
- Capability promotion: split candidate from validated, require evidence refs
- Governance enforcement service: resolve persisted refs, not spoofable booleans
- Claim ledger v2: typed predicate/object/scope, explicit contradiction edges
- Evidence graph lineage resolver: forward/reverse traversal, dashboard summaries
- Runner manifest auto-write: all action types (skip, stop, kill, timeout, drain)
- Capacity governor live scheduler: fair-share weights, concurrency slots, budgets
- OKF skill sync and hypothesis workbench: candidate indexing, profile versions
- Mission Control drill-through: metric → evidence chain

### Phase 3 — G16 No-Theater Proof (64 tasks)
- Runtime contract repair: Codex flags, shared probe, contract fixtures
- Enforcement repair: OKF allowlist, scoped permissions, typed claims, manifest spoofing
- OpenCode MCP/skills health: config inspector, MCP list, skill scanner
- OpenAI capability descriptors: Agents SDK, Skills, MCP/connectors
- Proof run service: rollback-scoped demo records across all tables
- Proof API/CLI: POST /proof-runs, GET status, POST rollback, npm scripts
- Mission Control proof output: live counts, evidence links, missing evidence
- Live workstation proof smoke: zero-state → proof run → nonzero → rollback

### Phase 4 — Pi Executor + Loop Runtime (49 tasks)
- Pi executor: JSON event mapping, cancel/SIGTERM, e2e sovereign run
- Pi loop runtime: union sites, contract probe, args, usage parsing
- Pi docs: integrations.md status update

### Phase 5 — Agentic Loop Fleet Closure (9 tasks)
- Docs: Ruflo inspiration only, Codex/OpenCode target
- Codex/OpenCode contract capture from local binaries
- Loop resume from persisted state after restart
- Skill validation before active loop use

### Phase 6 — Workstation Deployment (43 tasks)
- Commit scoped worktree, deploy to workstation
- Verify server health, runtime contracts, swarm status, dashboard
- Run scheduler tick in safe mode
- Capture evidence for all verification points

## Guardrails

- No auto-merge, push or deploy without explicit operator command.
- No unattended high-risk worker execution.
- No automatic policy, security or autonomy memory promotion.
- No new canonical store besides OKF files and SQLite runtime state.
- No claim that registry rows, prepared leases or agentCount are active execution.
- Proof runs use rollback-scoped records; production data is never touched.
- All changes must pass `openspec validate --strict`, `npm run test`,
  `npm run type-check`, and `npm run lint`.

## Success Criteria

- All 256 unchecked tasks across 7 changes are checked off with evidence.
- `openspec validate <change> --strict` passes for all 14 changes.
- `npm run test` exits 0 (373+ tests passing).
- `npm run type-check` exits 0.
- `npm run lint` exits 0.
- `git status --short` is empty.
- A proof run demonstrates nonzero goals, loops, leases, capabilities, claims,
  manifests and panels with rollback.
- No auto-merge/push/deploy/high-risk-unattended in any smoke or proof.
