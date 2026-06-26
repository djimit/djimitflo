# Djimitflo Swarm Platform — Product Proof Summary

## What Djimitflo Is

A production-grade AI agent orchestration control plane with governed swarm
intelligence, enforced capability routing, evidence-backed decision making,
and no-theater proof runs.

## What's Proven

| Capability | Evidence |
|-----------|----------|
| Control loops | 23 loop-service tests, 7 loop contracts, maker/checker/gate lifecycle |
| Worker fleet | Mock/Codex/OpenCode/Claude/Gemini/Pi runtimes with contract probing |
| Swarm intelligence | Mission/task/decision state machine, capability registry, specialist panels |
| Enforcement | Capability gates, governance completion, circuit breaker, auto-manifests |
| Evidence graph | Claims with typed statuses, contradiction edges, lineage resolver |
| Learning flywheel | OKF capability sync, loop learning closure, memory candidates |
| Proof runs | ProofRunService creates rollback-scoped demo records across all tables |
| Dashboard | Mission Control with execution truth, proof section, drill-through |

## Key Numbers

- **404 tests passing** across 41 test files
- **14 OpenSpec changes** all validate strict
- **7 complete changes** (100% tasks checked)
- **6 runtime adapters** (Codex, OpenCode, Claude, Gemini, Pi, Mock)
- **7 loop contracts** (doc-drift, repo-maintenance, skill-quality, MCP, security, OKF, policy)
- **12 swarm intelligence service methods** (capability, claim, evidence, capacity, manifest, mission, task, decision)

## Architecture

```
OKF (canonical knowledge) → KnowledgeRuntimeService → capability sync
                                                           ↓
Goals → Loops → Worker Leases → Maker/Checker → Gates → Evidence Graph
                    ↑               ↓                ↓
            Capability Gate    Runner Manifest   Claims + Edges
                    ↑               ↓                ↓
            SwarmIntel     Auto-Write         Lineage Resolver
              ↓                                  ↓
         Circuit Breaker                    Mission Control
                                              ↓
                                         Proof Run + Rollback
```

## Guardrails

- No auto-merge, push or deploy
- No unattended high-risk execution
- No automatic policy/security memory promotion
- Draft/candidate capabilities cannot route live workers
- OpenAI descriptors cannot route local workers without adapter proof
- Governance blocks completion when claims are unresolved
- Circuit breaker trips after 3 repeated failures

## Commands

```bash
npm run swarm:proof          # Run mock proof
npm run swarm:proof:rollback # Rollback proof
npm run test                 # 404 tests
openspec validate <change> --strict  # Validate any change
```
