# NE-011 — Unvalidated agent-ecosystem claims (ChrisRoyse repositories)

**Verdict:** REJECT · **Decided:** 2026-10-14 · **Evidence class:** read-only source review (shallow clones, nothing installed, built or run; clones deleted).

## Hypothesis

Adopting code or mechanisms from these repositories improves Djimitflo's discovery, swarm routing, model compression or code-knowledge graph.

## Repositories (pinned short commits)

| Repo | Commit | Claim | What the code shows |
|---|---|---|---|
| Serendipity | `56e38e5a` | DSPy-driven serendipitous discovery, meta-agent generator | Deno event-matching app; `dspy_mock.ts` is a cheerio scraper (DSPy is a mock); no meta-agent generator in `src/`; 7,994 `node_modules` files and a user DB with password hashes committed; no LICENSE file |
| Pheromind | `994b04d9` | Pheromone-based swarm orchestration | Prompt and methodology markdown; the only code is a regex secret scanner; framework stated proprietary (README:111) |
| NeuralShrink | `be116d14` | "≥ 95 % accuracy preserved", "61 % smaller" | One compression script; the accuracy figure is a config value (`accuracy_target`, `granite_compress.py:89,150`); no evaluation, perplexity or benchmark anywhere; no licence |
| Cognitive-Triangulation-Pipeline | `71a014b4` | LLM-built code knowledge graph with benchmarks | "Benchmarks" are node and relationship counts, not accuracy; a live-looking API key is committed in `.env` (redacted; owner should rotate); no lockfile at root; no LICENSE file |

## Finding

The common pattern is a **claim without any evaluation**: a mocked dependency, a configuration knob reported as a result, or counts reported as benchmarks. No fabricated benchmark code was found (unlike NE-007). None of these touches Djimitflo's limiting stage (verified → merged → settled).

## Existing Djimitflo equivalents

Discovery: scout + relevance gate. Swarm routing: bandit with fitness shadow, committee arena. Code graph: `repo-graph-builder`. Model compression: no consumer (inference is Ollama Cloud + llama.cpp).

## Threats to validity

Shallow clones at one commit; later commits may differ. Read-only review: no claim was disproven by execution, only shown to lack any evaluation in code.

## Not covered by this entry

contextgraph (`54e3a598`) is not a negative: it publishes honest negative results; only its PolyForm Noncommercial licence blocks code reuse (ideas adapted in-house). CodeGraph and Astrolabe are recorded in the assessment (REJECT as dependency: shell-executing MCP with auto-allow; shipped agent skills and telemetry).

## Reopen condition

A pinned release with a reproducible evaluation against a simple baseline on real outcomes, an explicit acceptable licence, and no committed secrets or dependencies — then a new pre-registered evaluation, not adoption.
