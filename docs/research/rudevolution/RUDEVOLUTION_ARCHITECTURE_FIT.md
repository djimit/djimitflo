# ruDevolution — architecture fit

Evaluated 2026-10-09 against DjimitFlo `origin/main` @ `3eebe3bb` and ruvnet/rudevolution @ `b99ec70c780e249b151de5c32ee9839784671962`.
Labels: VERIFIED (code/test/reproduced), INFERRED, CLAIMED, UNKNOWN, FAILED.

## Verdict

ruDevolution does not fit. DjimitFlo has a real gap (no inspection of shipped/minified JavaScript), but ruDevolution does not fill it: its core
returned one module for every real bundle and recovered 0 of 571 original names (see RUDEVOLUTION_BENCHMARK.md). Decision: **NO_GO** (ADR).

## DjimitFlo baseline (what exists today)

| Capability | Component | Covers shipped/minified JS? | Label |
| --- | --- | --- | --- |
| JS/TS parsing | only `typescript` (devDependency); used in `scripts/route-source-inventory.mjs:6` | no | VERIFIED |
| Repo indexing / search | `services/repository-index-service.ts` (skips `dist`, `build`, `node_modules`, `:245`) | no (by design) | VERIFIED |
| Code graph | `services/repo-graph-builder.ts:80` (same skips) | no | VERIFIED |
| Explainer Fleet | `services/explainer-*` (source repos; "bundle" there = documentation bundle) | no | VERIFIED |
| PR review | `services/github-pr-review-service.ts:232` (source diff) | no | VERIFIED |
| Dead-code / dependency lanes | `services/dead-code-source-service.ts`, `services/dependency-lane.ts` (semver + CI only) | no | VERIFIED |
| Mutation tasks | `services/gym-mutants.ts` (regex line mutations, no AST) | no | VERIFIED |
| CI supply chain | npm audit (`scripts/ci-audit.mjs`), Trivy fs+image, SBOM (anchore CycloneDX + `/sbom` route), CodeQL, gitleaks, Dependabot | manifest/advisory level only | VERIFIED |
| Runtime admission | `execution/runtime-admission.ts` CRITICAL `supply_chain` gate; evidence is hand-written strings | no automated dist inspection | VERIFIED |
| Evidence / provenance | authority ledger, `/evidence`, `/compliance`, P1 content-hash seal | n/a | VERIFIED |
| EVE-V | `execution/execution-engine.ts:1103-1127` holds deep-agent completions with `EVE_V_ADAPTER_REQUIRED` — adapter not installed | no | VERIFIED |
| Consumers of bundle analysis | none found (no lane, gate, judgment or EVE-V hook reads it) | — | VERIFIED by absence |

## The real gap

Not present anywhere (grep for minif/sourcemap/tarball/postinstall/deobfusc/decompil/webpack found only prose): inspecting the `dist/` code of
npm packages and agent runtimes we execute, diffing shipped code between releases, and detecting install scripts, network endpoints,
`eval`/dynamic `require` in shipped code.

Natural owner if ever built: the existing **runtime-admission `supply_chain` gate** (it already demands evidence refs for npm-distributed
runtimes and today accepts hand-written ones), then the **dependency lane** as a skip reason before `would_merge`. No new component needed.

## Why ruDevolution is not the answer to that gap

- It addresses a different problem (renaming and splitting a single bundle into "modules"), not supply-chain inspection.
- What it does, it does incorrectly (FAILED module boundaries, FAILED renames, non-semantic output) — see FALSIFICATION_REPORT.
- The gap is answered by simpler, maintained tools (static scan of package tarballs for install scripts, network APIs, dynamic code) — see ADR option B.
