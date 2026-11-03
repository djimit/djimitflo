# OpenHuman — code-level verification (Phase 0–1)

Date 2026-10-01. Method: falsification. The question was whether OpenHuman can be shown *not* to fit Djimitflo.

## Phase 0 — Djimitflo baseline

| Item | Value |
|---|---|
| Analysed commit | origin/main `47818d5b` (prod, post-deploy verdict_ok 2026-10-01 09:59Z) |
| CI on that commit | green: build-and-test, mutation-test, security-scan, CodeQL ×3, gitleaks, sbom |
| Local checkout | branch `audit/fase5-close-loop` with the user's uncommitted changes (`.opencode/*`, openspec evidence JSON, `.audit-probes/`, `.codex/config.toml`). **Not touched.** The analysis ran in a separate worktree. |
| Known failures | mutation-test hook-timeout flake (fixed in #563); Node 24 timing flake in `loop-runtime-stop` |
| Gate order before any executor | `execution-engine.ts:319` riskClassifier.assessTask → `:320` policyDecisionService.evaluate → `:324` governanceGate.assess (tighten-only) → ApprovalService; re-checked on resume (`:493–495`) |
| Executors | registered in the constructor (`execution-engine.ts:158–170`); `ExecutorKind` in `execution/types.ts:10` |
| Other authorities | leases, budgets, lineage (`evolve_sibling_of`), skill_outcomes, genome registry, evidence/authority events, memory review (P1 hash seal) — all inside Djimitflo |

## Phase 1 — OpenHuman upstream

Source: `github.com/tinyhumansai/openhuman` @ `0e703ed4` (2026-10-01, shallow clone), plus 18 git submodules under `vendor/`. The submodules were **not** fetched; the reason is under "Supply chain" below.

| # | Question | Finding (file evidence) | Verdict |
|---|---|---|---|
| 1 | Does `openhuman-embed` exist with a host API? | Yes. A Rust library facade with `Runtime`, `RuntimeBuilder`, `Turn`/`TurnRequest`/`TurnOutcome`, `HostTools` and `Access` (`crates/openhuman-embed/src/lib.rs:98–111`). It is `publish = false` (not on crates.io) and Rust-only, so there are no Node bindings. | PARTIALLY_VERIFIED |
| 2 | Multi-agent hosting in one runtime | `examples/two_agents.rs`; `Runtime::agent(AgentSpec)` | VERIFIED |
| 3 | AgentSpec | `crates/openhuman-embed/src/agent/spec.rs:35`: id, definition (prompt, tool scope, sandbox, iteration cap), provider, access, tool_groups, domains, mcp_servers, skills_dir, trusted roots, composio, a `config_fn` escape hatch, host_tools | VERIFIED |
| 4 | Tools, MCP and skills | Tool groups (`ToolGroups`), per-agent MCP servers (feature `mcp`, `timeout_secs` per server), and skills (feature `skills`) | VERIFIED |
| 5 | Security policy defaults | **`AutonomyConfig::enabled` defaults to `false`; every enforcement entry point short-circuits on it** (`security/README.md` §"The policy is off by default"). Only the forbidden-path list (`.ssh`, `/etc`, …) is unconditional. | VERIFIED: off by default |
| 6 | Sandbox / isolation | The legacy Docker/Bubblewrap/Firejail/Landlock backends were removed. Confinement is delegated to `tinybox-jail` (submodule), plus the `sandbox-landlock` feature and `SANDBOX_ENV_PASSTHROUGH` (env allowlist). | PARTIALLY_VERIFIED (the implementation lives in an unfetched submodule) |
| 7 | Approval model | OpenHuman has **its own** in-process approval gate: 10-minute TTL, timeout means deny. `Access::full` labels turns as trusted automation and skips that gate. | VERIFIED (a competing approval authority) |
| 8 | Cancellation and timeout of a turn | The embed API exposes no turn-level `cancel`/`abort`/`timeout`; only MCP per-server `timeout_secs` exists. A host can only kill the process. | CONTRADICTED for in-library control. A subprocess kill is the only reliable option. |
| 9 | Secrets | `SecretStore` (encrypted on disk, keychain master key), `redact()` and an env passthrough allowlist. The default provider is the hosted TinyHumans backend with an API key (`th_…`). | PARTIALLY_VERIFIED |
| 10 | TinyJuice | The core carries only the wire contract (`tinyjuice-bus`) plus a stateless `html_to_markdown`. The router, the compressors, the "CCR cache" and ranged retrieval sit in the `tinyjuice` module, behind a loadable-module boundary and a GPL-3.0 submodule (`crates/openhuman-core/Cargo.toml:600–625`). It is compression middleware in the agent turn path. | PARTIALLY_VERIFIED. Recoverability not verifiable without the module. |
| 11 | Jev | OpenHuman's Jev is a **`tool_search` ranker** (Choice over an embedding shortlist). It is reached through the TinyHumans backend proxy `/agent-integrations/openrouter/systemone` with the TinyHumans credential and falls back to BM25 (`crates/openhuman-tinyhumans/src/jev/README.md`). It is not a general decision service. | VERIFIED (narrow) |
| 12 | Memory Tree | `memory/tree/`: a markdown summary tree plus a SQLite/vector store and provider sync pipelines (Obsidian, conversations, people, goals, preferences); the core lives in `tinymemory` (submodule). It is a full memory system, not a projection. | VERIFIED (a competing canonical memory) |
| 13 | TinyFlows | `flows/`: saved workflows with CRUD/enable/run/resume/cancel, triggers and a state-graph runtime inside `tinyflows` (submodule). Plus `cron/`. | VERIFIED (a competing scheduler and workflow engine) |
| 14 | A2A | No A2A protocol code in `openhuman-core` (the only grep hit was a sha256 string). | UNVERIFIED (not found) |
| 15 | Nested agents | `spawn_subagent` tool, `orchestration/` (command center, workflow runs, agent teams, worktrees), `run_ledger`, `learning`, `agent_experience`, and a runtime-wide delegation catalog (`orchestrator`, `summarizer`) | VERIFIED (a competing orchestrator, lineage and learning) |
| 16 | "Embed in any host" claim vs code | Rust-only, unpublished, and it needs 18 submodules to build. The npm `openhuman` package (0.1.5, labelled MIT) is a wrapper whose `postinstall` downloads a GPL binary from GitHub Releases. Its checksum comes from the same origin as the tarball, so it guards against corruption, not compromise. | CONTRADICTED for a Node host |

### Supply chain and licence

- `openhuman` is **GPL-3.0**. So are all 7 submodules checked via the GitHub API: tinyjuice, tinyagents, tinyflows, tinymemory, tinybox, tinyruntime and tinymcp. `tinyhumans-sdk` returns 404 (private or renamed), so the build is not reproducible from public sources.
- Djimitflo is MIT. Linking the core into Djimitflo, through a native binding or by vendoring, makes the combined work GPL-3.0. A separate process is arm's-length but still ships a GPL binary inside the image.
- Change rate: the submodules were pushed today (2026-10-01 01:10–11:27Z), and the embed crate is unpublished. **There is no stable API to pin.**
- Per the hard constraints, no dependency was added and no submodule was fetched or built. The supply-chain analysis above is the reason.

## Phase 10 — Benchmarks

**None run.** OpenHuman cannot be built without the 18 GPL submodules (one of which is not public), and fetching and building them is the dependency step these findings rule out. No numbers are reported; none are extrapolated.
