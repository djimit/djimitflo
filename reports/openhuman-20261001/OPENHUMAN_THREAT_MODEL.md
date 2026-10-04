# OpenHuman — threat model (Phase 3) and invariants (Phase 9)

Principle: Djimitflo policy is enforced **before** execution. OpenHuman's SecurityPolicy is at most defence in depth. Fail closed.

## Threats

| # | Threat | OpenHuman evidence | Effect if integrated | Mitigation available? |
|---|---|---|---|---|
| T1 | Policy bypass | SecurityPolicy off by default | The agent acts outside Djimitflo's risk class | Only via external sandbox + pre-approval |
| T2 | Self-approval | `Access::full` skips the in-process approval gate | Actions without an operator decision | Djimitflo approves the whole turn, but the scope inside the turn is unbounded |
| T3 | Scope escalation | `config_fn` escape hatch, `allow_tool_install`, `spawn_subagent`, runtime-wide delegation catalog | Turn widens its own tools/agents | Not provable without a build |
| T4 | Uncontrolled nesting | `spawn_subagent`, agent teams | Budget and lineage invisible (INV-09) | Disable tool group (unverified) |
| T5 | Second control plane | command center, cron, flows, run ledger, learning | Split-brain state; who is authoritative? | Not provable without a build |
| T6 | Evidence corruption | TinyJuice in the turn path (lossy) | Compressed tool output becomes "evidence" | Never use as evidence (INV-04/07) |
| T7 | New outbound third party | default provider = TinyHumans hosted backend; Jev via its proxy | Code/prompts leave via an unvetted service; violates "no new outbound targets" | Force own provider; still default-on hosted surfaces |
| T8 | Supply chain | GPL-3.0 core + 18 fast-moving submodules (1 private); npm postinstall downloads a binary with a same-origin checksum | Unreproducible build, licence contamination, binary swap | No mitigation short of a vendored, pinned, reviewed build |
| T9 | Secrets | `SecretStore` with keychain master key; env passthrough allowlist | Second secret store on the host | Pass only the model key via env; no keychain in containers |
| T10 | No cancellation | No turn-level cancel/timeout in the embed API | Runaway turns | Process kill (subprocess only) |
| T11 | Memory poisoning | Memory Tree + provider sync (Obsidian, conversations) | Untrusted content in a canonical store | Not integrated |

## Invariants

The status "holds trivially" means it holds because nothing was integrated. That is the honest state; none was tested against a running OpenHuman.

| Invariant | Status | Evidence |
|---|---|---|
| INV-01 cannot bypass Djimitflo policy | Holds trivially | No executor registered; engine gate order unchanged (`execution-engine.ts:319–324`) |
| INV-02 cannot self-approve | Holds trivially | — (T2 shows it *could* inside its process) |
| INV-03 cannot promote | Holds trivially | Promotion only via genome registry / human merge |
| INV-04 not canonical evidence | Holds trivially | — |
| INV-05 no direct canonical memory mutation | Holds trivially | — |
| INV-06 stays in capability scope | **Not provable** for any integration | T3 |
| INV-07 TinyJuice cannot destroy evidence | Holds trivially (rejected) | — |
| INV-08 Jev cannot override policy | Holds | Djimitflo's own jev judgments are shadow/enforce per judgment, never in the engine's policy path |
| INV-09 nested agents under Djimitflo budget/lineage | **Not provable** for any integration | T4 |
| INV-10 disabling restores behaviour | Holds trivially | No code, no flag, nothing to disable |
