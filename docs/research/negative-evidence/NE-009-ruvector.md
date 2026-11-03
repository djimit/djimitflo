# NE-009 — RuVector (ruvnet/RuVector), whole repository, as a Djimitflo dependency or tooling

| Field | Value |
|---|---|
| Repository | https://github.com/ruvnet/RuVector |
| Reviewed commit | `46d816ddc4c2a8a06cd3613534a79b1d557d858b` (2026-10-14; still remote `main` HEAD on 2026-10-20) |
| Prior pin | `75653afa` (sparse-attention crate 0.1.1, NO_GO on 2026-10-11; 0 changes to that crate since) |
| Review date | 2026-10-20 |
| Method | Source read only: shallow clone with `core.hooksPath=/dev/null` and LFS smudge off, read with grep/find/sed, clone deleted. Not opened as a Claude Code or IDE project. Nothing was installed, built or run. |
| Licence | MIT (root); crates MIT or "MIT OR Apache-2.0". No licence blocker. |
| Scale | 197 Rust crates (1.42M LOC, 1,953 `unsafe`), 62 npm packages, 335 ADRs, 86 committed `.node`/`.wasm` binaries |
| Reviewer | Claude (Djimitflo operator session), read-only review |
| Decision | Operator, 2026-10-20: REJECT for the whole repository, documentation only |

## What it is in code

A very large, essentially single-author, heavily LLM-generated monorepo: a real HNSW vector DB core (`ruvector-core`), many ANN,
quantization, GNN, attention and LLM-runtime crates, Node/WASM bindings with committed prebuilt binaries, a 118-tool MCP server,
and Claude Code hooks that feed a "shared brain" service at `pi.ruv.io`.

## Findings

Confidence: **verified** = read directly in the source at the reviewed commit; **limitation** = a design property, not a bug.

| # | Finding | Class | Confidence | Source |
|---|---|---|---|---|
| A | Benchmark recall hardcoded to 1.0; Python baseline simulated as `rust_latency * 15`; committed `bench_results` report "Recall@10: 100.00 %". | verified defect | high | `crates/ruvector-bench/src/bin/comparison_benchmark.rs:130-132, 177-179, 208-213, 230-232, 288-290`; `latency_benchmark.rs:145-147, 209-211` |
| B | `ruvector-sota-bench` generates synthetic Gaussian data under real ANN-Benchmarks names (`glove-25-angular`, `sift-128-euclidean`, …); reports do not mark it synthetic. | verified defect | high | `crates/ruvector-sota-bench/src/lib.rs:107-118` |
| C | Claude Code hooks POST commit messages and session diff stats to `https://pi.ruv.io/v1/pipeline/inject` with a committed shared token `ruvector-crawl-2026`; the project's own ADR says the server accepts any 8-character key. | verified defect | high | `.claude/settings.json:46, 90, 197-198`; `docs/adr/ADR-349…:358-364` |
| D | Hook helper spawns detached, unpinned `npx @claude-flow/cli` (resolves `@latest`) with `env: process.env`; `permissions.allow` pre-approves `Bash(npx @claude-flow*)` and `mcp__claude-flow__*`; `ruvector hooks init` writes `npx ruvector@latest` into the user's settings. | verified defect | high | `.claude/helpers/hook-handler.cjs:80-95, 150-165`; `npm/packages/ruvector/bin/cli.js:4299, 4323` |
| E | MCP server is allow-all when no policy is configured, contradicting its "default-deny" header; `workers_*` tools run `npx agentic-flow@alpha`; `decompile_url` fetches any http(s) URL (SSRF); `brain_*` tools send content to `pi.ruv.io`. | verified defect | high | `npm/packages/ruvector/bin/mcp-policy.js:2-17`; `bin/mcp-server.js:172, 3278-3478, 4124-4131` |
| F | GNN "improves with use" and SONA "LoRA learning" have no training or feedback code path (forward passes only; SONA "gradient" is a centroid average). | verified defect | high | `crates/ruvector-gnn/src/layer.rs`, `training.rs`; `crates/sona/src/loops/background.rs:180-226` |
| G | Sparse attention (NO_GO at `75653afa`, unchanged): untrained hash-seeded gate, no SIMD, O(T) per decode step, accuracy only tested where window ≥ sequence. | verified defect | high | `crates/ruvllm_sparse_attention/src/fastgrnn_gate.rs:60-80`; `attention.rs:1101-1102, 2044-2095` |
| H | Platform `.node`/`.wasm` binaries are committed by a CI bot (the reviewed HEAD commit itself), so a published package cannot be tied to reviewed source. | verified defect | high | `npm/core/platforms/*/ruvector.node`; HEAD commit |
| I | No ROCm/HIP/Vulkan backend (candle CPU/Metal only); cannot use the R9700, where llama.cpp already does GPU attention. | limitation | high | `crates/ruvllm` backends |
| J | At ~1.4k vectors, exact SQLite cosine is already the recall ceiling; a second vector store would add a fourth embedding space, not unify three (UX-21). | limitation | high | `docs/design/embedding-unification.md` |

## Threat scenarios (if any part were used)

- Opening a checkout in Claude Code with hooks active sends the session's git metadata to a third-party endpoint anyone can write to (C).
- Every hook event or MCP worker call executes whatever `@latest` / `@alpha` currently resolves to, with the full environment (D, E).
- An agent using the MCP server fetches attacker-chosen URLs from inside the network (E).
- A RuVector benchmark number is cited as evidence for a design decision (A, B).

## Allowed follow-up

In-house TypeScript re-implementation of two public techniques seen there, each only after a controlled comparison on Djimitflo's
own labelled data: reciprocal rank fusion (Cormack et al. 2009) for cross-source context ranking, and a hashed embedding-space
identity that includes the query/document prefix policy. No RuVector code; not covered by this entry.

## Reopen conditions

**All** of: (A) a benchmark independently reproduced on Djimitflo's own data in our own harness, with recall computed against exact
search and no simulated baselines; (B) hooks and MCP server removed or default-deny, with no network calls by default; (C) pinned
releases with build provenance tying binaries to source; (D) a concrete need that SQLite cosine, Qdrant or llama.cpp cannot meet.
Meeting them permits a new pre-registered evaluation, not adoption.

## Reproduction

`git clone --depth 1 -c core.hooksPath=/dev/null https://github.com/ruvnet/RuVector` and fetch
`46d816ddc4c2a8a06cd3613534a79b1d557d858b`, then read the files cited above. Never open the checkout as a Claude Code or IDE project
with hooks active, and do not install or run anything outside an isolated sandbox approved by the operator.
