# Assurance Truth Closure — Execution Evidence

Status: **blocked (fail-closed)** on 2026-07-31.

## Proven locally

- Full repository tests passed: 217 test files, 1,826 tests passed, 20 skipped.
- Type-check, lint, build, production dependency audit and `git diff --check` passed.
- Worktree dependency inheritance is covered by a focused 8-test suite.
- Nested specialist execution is provenance-gated and covered by a focused 14-test suite.
- A real Codex maker/checker/nested-agent run traversed the complete execution path. Two defects found by that run were fixed: proof metadata loss at completion and rejection of provenance-backed nested specialist leases.
- SQLite integrity returned `ok`; local health and version endpoints returned HTTP 200.
- OpenMythos structural gates passed: 351 corpus cases and 18 lifecycle oracle cases with exact six-stage coverage.

## Blocking evidence

- Local shell is Node 26; the supported contract is Node 20 through 24. CI now covers 20, 22 and 24 with isolated `npm ci`, but those remote jobs were not run from this dirty checkout.
- HTTP contract inventory: 517 routes, 136 directly mapped to request-level tests, 37 critical routes still unclassified. MCP: 43 tools, 29 tested, zero critical tools unclassified.
- OpenMythos broad certification is inadmissible: only 7 cases are validated; repeatability and held-out discrimination were not run.
- Required workstation services at `192.168.1.28` (Ollama, LiteLLM and Qdrant) are unavailable. Codex 0.146.0 and OpenCode 1.17.18 are available locally.
- Live deployment identity is unproven: the checkout is dirty and the protected provenance endpoint returned HTTP 401. Database integrity alone is not deployment identity.
- The final real-runtime run completed execution but returned `proof_class=demo` because completion lost runtime metadata. The runtime-restoration fix passes deterministic gates, but a further six-minute non-mock rerun was deliberately left as an explicit remaining validation gate rather than claiming success without evidence.
- Strict OpenSpec CLI validation is blocked because the `openspec` executable is unavailable.

## Mutation boundary

No commit, push, merge, deploy, restart, corpus promotion or external durable-memory promotion was performed. Restoring workstation services, authenticating live provenance, or deploying/restarting requires operator authority outside this local change.
