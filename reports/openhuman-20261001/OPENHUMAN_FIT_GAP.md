# OpenHuman — fit-gap (Phase 2, 4, 6–8, 11)

Rule: OpenHuman may not own task, governance, approval or evidence authority, canonical memory, worker lifecycle, capability registry, federation or promotion. If that cannot be enforced → STOP.

## Overlap per authority

| Authority | Djimitflo today | OpenHuman equivalent | Can OpenHuman's copy be switched off and *proven* off? |
|---|---|---|---|
| Task / worker lifecycle | execution engine, leases, loop daemon | orchestration/command_center, workflow runs, agent teams | Not without building it (submodules). `ToolGroups`/`domains` narrow tools, but the default catalog includes `spawn_subagent` and built-in `orchestrator` |
| Approval | ApprovalService (operator) | in-process approval gate (10-min TTL) | `Access::full` bypasses it, so OpenHuman would self-approve inside its own process. That is acceptable only if Djimitflo approves the whole turn first, and only if the turn cannot widen its own scope (unprovable: `config_fn` escape hatch, tool install flag) |
| Policy | risk classifier, PolicyDecisionService, governance gate | SecurityPolicy (**off by default**) | Off is the default. Defence in depth would need it switched *on*, which its own docs call unusable for shell |
| Evidence / audit | evidence + authority events | `AuditLogger`, `run_ledger` | A second ledger; it would have to be ignored |
| Memory | memory_candidates + review + hash seal + fitness | Memory Tree + tinymemory + sync pipelines | A second canonical store |
| Scheduling | loop daemon, auto-deploy timer | `cron/`, `flows/` triggers | A second scheduler |
| Learning / promotion | skill_outcomes, bandit, genome registry, holdout | `learning`, `agent_experience` | A second learning loop |
| Lineage / budget | `evolve_sibling_of`, token brake, caps | `spawn_subagent` iteration caps | Nested agents are invisible to Djimitflo's budget and lineage (INV-09) |

**Result: the "cannot be enforced" condition holds.** Seven of the eight authorities have a live competing implementation inside OpenHuman. Whether each is disabled cannot be verified without building GPL submodules (one of them private). By the prompt's own rule, this is a **STOP for integration**.

## Gap: what would OpenHuman add?

Djimitflo already runs 11 executors, including opencode, codex, claude, hermes, atomic (local R9700), remote (workstation pull) and deep-agent. The gym measured atomic@llama-router at 87–90 % and opencode at 40–50 %. OpenHuman brings no capability that an existing executor lacks *and* that the oracle lanes need. "No architecture change just because OpenHuman offers it" → there is no gap to fill.

## Decisions per component

| Component | Decision | Why (survived falsification?) | Re-open when |
|---|---|---|---|
| OpenHumanExecutor | **HOLD** | No stable, published, licence-compatible interface. There is no turn-level cancel. The security policy is off by default. It ships a competing control plane. No gap. | A published non-interactive CLI with JSON I/O and a stable version, an LGPL/MIT/Apache interface or a clean subprocess contract, policy defaults on, and a measured capability gap in a gym lane |
| TinyJuice | **REJECT** | Lossy compression in the turn path. Its engine is closed behind a GPL module. Djimitflo evidence must stay byte-exact (INV-04/INV-07). The experiment (Phase 6) was not run because the engine is not available without the submodule. | Never for evidence. For maker context only, if a permissive, recoverable engine appears; the T6 "context diet" already covers the idea |
| Jev (OpenHuman's) | **REJECT** | It is a tool_search ranker reached through the TinyHumans hosted proxy, which is a new outbound third party. Djimitflo already calls TypeSafe jev directly as a shadow/enforce judgment, never as a policy decision point (operator decision 30-09: jev is the only System One backend). | — (keep Djimitflo's own jev path) |
| Memory Tree | **REJECT** | It is a full memory system, not a projection, and it has no consumer. A projection would duplicate memory review plus fitness. | A consumer needs a read-only summary tree, which can then be built over memory_candidates |
| TinyFlows | **REJECT** | A second workflow engine and scheduler, explicitly forbidden | — |
| A2A | **REJECT** | Not found in code. There is nothing to adopt. | Upstream ships it and a federation need exists in Djimitflo |

## Phase 4/5 — design and PoC

Per the gates there is no `openhuman-executor.ts`, no ExecutorKind change and no feature flag. Writing an executor for a binary that cannot be built reproducibly would be the "fake mock to make integration green" the constraints forbid. If the HOLD is ever lifted, the design is fixed now:

- **Subprocess only** (never a native binding).
- **Per-turn approval in Djimitflo first.**
- **Sandbox:** a docker runner like gym-worker, with no network except the model endpoint.
- **Workspace and environment:** a scoped worktree; the env allowlist is the model key only.
- **Inside OpenHuman:** `Access::readonly` or a narrowed `ToolGroups` without `spawn_subagent`/flows/cron/memory sync.
- **Control:** a hard wall-clock kill; the patch goes back through the existing gates.
- **Failure mapping:** non-zero exit or timeout → `infra:`, never `success`.
- **No fallback** to an unsandboxed run.
