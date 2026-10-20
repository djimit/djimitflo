# NE-012 — ruvnet agent ecosystem (ruflo/claude-flow, agentic-flow, agentdb, autogenous, ruClip, dream-machine) as Djimitflo dependencies, hooks or MCP servers

| Field | Value |
|---|---|
| Scope | Org-level entry for github.com/ruvnet: 227 public repositories triaged (27 forks, 0 archived); the agent-ecosystem packages below rejected |
| Reviewed commits | agentic-flow `a2f6c1cfa709ba896f296d8d4f7804d379ed1a69` · agentdb `c5cc03a2732c7da1d8128d4fff7701a526af60bc` · autogenous `905aa6cbe213392f8b3cab5d4f17bc3a48e0a509` · ruClip `6e73a8f060bcbb69965a50ffe4627e33622d4094` · dream-machine `3fc3222d2e5566a203331d3686c4d2eaf06713a8` · reflective-engineer `3822d7365293957c6d22a652698f95307060d391` · readme-proof `d2dd66f96d904f3ea3f3a1c6eb1fecf85b390363` · ruflo `9271be48b0d23a31750a2e2220afa4c57ec3e26b` (re-checked via the API, no clone) |
| Review date | 2026-10-20 |
| Method | Metadata, top-level tree and README head for all 221 non-empty repositories via the GitHub API; shallow clones with `core.hooksPath=/dev/null` of 13 repositories, read with grep/sed only, clones deleted. Not opened as a Claude Code or IDE project. Nothing was installed, built or run. |
| Precedent | NE-011 (org-level entry for one author's repositories). NE-009 (RuVector) and NE-007 (ruDevolution) stay separate per-repository entries. |
| Reviewer | Claude (Djimitflo operator session), read-only review |
| Decision | Operator, 2026-10-20: REJECT at org level for the agent-ecosystem packages, documentation only |

## What it is

A single-author ecosystem (ruvnet plus bots: claude, lovable-dev[bot], github-actions[bot]) around a flagship agent harness
(ruflo, formerly claude-flow), a model router and agent runtime (agentic-flow), a vector memory on the RuVector engine (agentdb),
signed "governed evolution" (autogenous), an agent-company control plane (ruClip, a Paperclip reinterpretation) and a nightly
repository-evolution factory (dream-machine) that commits to the other repositories and publishes about one new package per day.
Newer repositories depend on the rejected core (ruClip `peerDependencies` `"*"` on ruflo/ruvector/metaharness/radio-moe; agentdb on
the RuVector NAPI engine; agentic-flow on `@metaharness/router` and `@ruvector/tiny-dancer`).

## Findings

Confidence: **verified** = read directly in the source at the reviewed commit; **limitation** = a design property, not a bug.

| # | Finding | Class | Confidence | Source |
|---|---|---|---|---|
| A | agentic-flow's "LLM Router (60 % cost savings)" rests on a synthetic 3-tier simulation; the router is a thin wrapper over `@metaharness/router` k-NN. Other headline numbers ("352x faster", "+55 % quality") have no measuring harness in the tree. | verified defect | high | agentic-flow `README.md:84,156-160`; `agentic-flow/benchmarks/cost-optimal-router-benchmark.mjs:4,12`; `agentic-flow/src/router/cost-optimal-router.ts:1-18` |
| B | agentdb's "+36 % search quality from feedback alone" cites a file that only asserts throughput floors; tautological tests compute the expected value in the test body. No held-out evaluation of the learning loop. | verified defect | high | agentdb `README.md:19,112,163`; `benchmarks/ruvector-performance.test.ts:73-386`; `tests/backends/self-learning-rvf.test.ts:591-597` |
| C | Install-time code: agentic-flow's `postinstall` rewrites another package's installed dist file. Postinstall scripts in 15 ecosystem repositories. | verified defect | high | agentic-flow `package.json:47`, `agentic-flow/package.json:36`, `agentic-flow/scripts/postinstall.js:86` (patches `agentdb/dist/controllers/index.js`) |
| D | Unpinned execution in hooks, MCP setup and runtime code: `execSync('npx claude-flow@alpha --version')`; the ruflo plugin hook runs `npx --prefer-offline --yes ruflo@latest hooks`; `claude-flow@alpha`, `@claude-flow/cli@latest`, `ruflo@latest` across ruflo, RuView, mcp-studio, agentdb (310 files in agentic-flow, 101 in agentdb reference `@latest`/`@alpha`). | verified defect | high | agentic-flow `agentic-flow/src/config/claudeFlow.ts:67`; ruflo `plugin/scripts/ruflo-hook.sh:34`; org code search |
| E | One Claude Code hook family (`.claude/helpers/hook-handler.cjs` on PreToolUse/PostToolUse/UserPromptSubmit/SessionStart/Stop) copied across ruflo, RuVector, mcp-studio, RuView, agentic-flow. `.claude/` in 26 repositories, `.mcp.json` in 9, `.claude-plugin/` in 16: opening a checkout on trusted infrastructure activates hooks or proposes MCP servers. | verified defect | high | agentic-flow `.claude/settings.json`; NE-009 finding D; org tree scan |
| F | autogenous provenance is self-certifying: `WitnessRecord::verify()` checks against the issuer key embedded in the record and `verify_chain()` never checks the issuer against a trusted set; the HTTP service takes pinned keys from the request body, signs any submitted corpus, binds `0.0.0.0` and falls back to public dev seeds `[1u8;32]`, `[2u8;32]`, `[3u8;32]`. | verified defect | high | autogenous `crates/witness/src/lib.rs:167-189`; `crates/service/src/main.rs:307-332, 396-401, 472` |
| G | ruflo MCP bridge: bearer auth is a no-op when `MCP_TOKEN` is unset; CORS default `*`. `terminal_execute` was default-allow until ADR-166 (unauthenticated-RCE remediation) and is now off by default. | verified defect | high | ruflo `ruflo/src/mcp-bridge/index.js:769-786, 890, 948-950`; `v3/docs/adr/ADR-166-mcp-bridge-unauthenticated-rce-remediation.md` |
| H | Committed binaries without provenance (`agentic-jujutsu.linux-x64-gnu.node`, `.wasm`, `.tgz`, SQLite `-shm` files). | verified defect | high | agentic-flow tree at `a2f6c1cf` |
| I | ruClip reimplements what Djimitflo already is (org chart, goals, heartbeats, approvals, signed audit) on top of ruflo/agentdb/autogenous; `lint` is `echo … && exit 0`. Its credential issuer does fail closed without a secret. | limitation | high | ruClip `package.json:34-39`; `src/control-plane/authorization/credential-issuer.ts:73-80` |
| J | dream-machine's "witness" is an unkeyed `sha256(sha256(report) ‖ commit)`, recomputable by anyone who edits the report; memory recall is substring overlap with no holdout. | verified defect | high | dream-machine `packages/witness/src/index.ts:1-12`; `packages/memory/src/selection.ts:4-9` |
| K | `cognitum.one/mcpSse` is a commercial remote MCP (lead capture, order lookup tools) registered by cognitum-claude-plugin and promoted from agentdb. | limitation | medium | cognitum-claude-plugin `.mcp.json`; agentdb `README.md` |

## Threat scenarios (if any part were used)

- Every hook event, plugin call or install executes whatever `@latest` / `@alpha` currently resolves to, with the session's environment (C, D, E).
- An install silently patches another dependency's code (C).
- A signed record or chain from autogenous is accepted as provenance although anyone can mint one (F).
- A ruflo MCP bridge started without `MCP_TOKEN` accepts unauthenticated tool calls from any origin (G).
- An ecosystem benchmark number is cited as evidence for a routing or memory decision (A, B).

## Existing Djimitflo equivalents

Routing: `runtime-bandit.ts`. Cost per verified change: `unit-economics.ts`. Provenance: deep-agent Ed25519 contracts with a pinned
public key (`deep-agent-contract-issuer.ts`, `deep-agent-executor.ts`). Memory/retrieval: SQLite cosine retrieval. Control plane:
Djimitflo itself (Paperclip retired 2026-09-21).

## Guard

`forbidden_code_patterns` (`claude-flow@alpha`, `@claude-flow/cli@latest`, `ruflo@latest`, `hook-handler.cjs`, `cognitum.one/mcpSse`)
may not appear in server/dashboard source, package manifests, lockfile names, `.mcp.json`, `.vscode/mcp.json`, `.claude/settings*.json`
or `.opencode/*.json` (`packages/server/src/__tests__/negative-evidence.test.ts`). `agentic-flow@alpha` is already guarded by NE-009
and is not duplicated. The federation adapter's OAuth issuer `auth.cognitum.one` (`packages/server/src/services/federation/adapter.ts`,
behind `DJIMITFLO_FEDERATION_ENABLED`, off) does not match `cognitum.one/mcpSse`; enabling federation is an external-MCP integration
and needs its own review first.

`match_terms` (`ruflo`, `claude-flow`, `agentic-flow`, `agentdb`, `ruClip`) flag generated proposals, dream mutants and discovery units
under `NE_GENERATOR_CHECK_MODE=shadow`. Deliberately excluded: `ruvnet`, `metaharness` and bare `cognitum`, which would match
legitimate idea-only references.

## Allowed follow-up

In-house re-implementation of public ideas, each evaluated on Djimitflo's own data and using no ruvnet code:

1. **Diff-hash credit** — credit a verified change once per artifact (diff) hash, not per run; the denominator is every predeclared slot including failures (idea seen in APx).
2. **Fail-before / pass-after + PASS_TO_PASS gate** — a test-writing or finding-fix lane's test must fail on the base and pass with the fix, plus a PASS_TO_PASS regression set; graders run with `--network none` (standard SWE-bench practice; CVE-bench omits PASS_TO_PASS and uses host networking).
3. **Ed25519 pinned-issuer pattern** — verify against an issuer key pinned per role in server config, never the key embedded in the record or a caller-supplied trust root; audience-bound single-use nonces, expiry and a durable revocation table (Agent-Name-Service v2; autogenous as the anti-pattern).
4. **Halt-on-unknown-after-restart** — on lease takeover a running side-effecting job becomes `uncertain`, the runtime halts and an operator reconciles; never auto-retry (rGi).

metaharness keeps its ADAPT-IDEA-ONLY status; NE-009 covers RuVector separately. None of these follow-ups is covered by this entry.

## Reopen conditions

**All** of: (A) a benchmark independently reproduced on Djimitflo's own data in our own harness against the current baseline, with no
simulated or hardcoded baselines; (B) no install scripts and no unpinned `npx …@latest/@alpha` execution; (C) hooks and MCP servers
off by default, authentication on, no network calls by default; (D) pinned releases with build provenance tying binaries to source;
(E) a concrete need that existing Djimitflo code cannot meet. Meeting them permits a new pre-registered evaluation, not adoption.

## Threats to validity

Shallow clones at one commit per repository; later commits may differ (ruflo already changed `terminal_execute` since the prior
review). Code-search counts cover default branches only and cap at 100 hits per query, so they are lower bounds. Triage of the
non-deep repositories is a judgement from README head and tree, not a code review. No claim was disproven by execution.

## Reproduction

`git clone --depth 1 -c core.hooksPath=/dev/null https://github.com/ruvnet/<repo>` and fetch the pinned commit above, then read the
cited files. Never open a checkout as a Claude Code or IDE project with hooks active, and do not install or run anything outside an
isolated sandbox approved by the operator.
