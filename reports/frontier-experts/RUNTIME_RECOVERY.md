# Frontier Experts runtime recovery

The deployed registry contained 1,094 identities and 48 papers, but zero taxonomy rows, capabilities or ACTIVE experts. Even an English query containing taxonomy aliases returned `no_capability_match`. A separate compiled-runtime probe returned no model runner despite a configured Ollama runtime.

## Fixes

- Normal migrations seed the existing idempotent taxonomy; startup and operator scripts no longer depend on a separate manual seed.
- Offline recomputation advances an evidence-only candidate to CAPABILITY_INFERRED when its stored papers support capabilities. It never approves or activates candidates.
- The lazy model import includes `.js`, as required by Node's native dynamic import in the compiled server.
- Structured expert reports reserve 4,096 output tokens and disable the Ollama thinking channel. Commons keeps its existing defaults. See [Ollama thinking API](https://docs.ollama.com/capabilities/thinking).
- Enrichment retains the full author list. Truncating it at 20 names removed the subject from large collaborative papers.
- A peer review cross-checks each capability against the target's sources through a different documented research lens. Supported decisions require known evidence IDs from both dossiers. Missing evidence may yield uncertainty; invented references and self-review are rejected. Profile version drift invalidates the review.
- Reviews are audit receipts, visible on the expert detail page. Neither a model review nor an agreement between models grants approval. They are AI analyses, not participation or endorsements by the named researchers.

## Operations

Back up the SQLite database using its online backup API before repair. Run against the intended database and the same built revision as the server:

```sh
node packages/server/dist/scripts/enrich-experts.js --db /data/djimitflo.sqlite --recompute
node packages/server/dist/scripts/enrich-experts.js --db /data/djimitflo.sqlite --source datacite --batch 15 --spacing-ms 1500 --once
node packages/server/dist/scripts/review-experts.js --db /data/djimitflo.sqlite --limit 20 --log /data/expert-peer-reviews.jsonl
```

The review command is bounded, records failures and resumes unchanged successful receipts. It does not change lifecycle state. `POST /api/swarms/expert/experts/:id/peer-review` accepts `{ "reviewer_id": "expert:..." }` under the existing operator authentication and feature flag. Review and approval remain separate from ingestion and from each other. Unknown or ambiguous identities stay excluded.

Compiled-module regression check (loads the real provider without making a model call):

```sh
node -e 'const a=require("node:assert/strict");require("./packages/server/dist/services/expert-council-service.js").createModelPerspectiveRunner({FRONTIER_EXPERTS_RUNTIME:"ollama:qwen3.5:cloud"}).then(r=>a.equal(r.label,"ollama:qwen3.5:cloud"))'
```

## Validation

The new regressions first failed on missing taxonomy initialization and stuck EVIDENCE_COLLECTED state. After repair they pass. Build and typecheck pass; lint has no errors (one pre-existing unused eslint-disable warning). The full workspace suite passed 3,011 tests, with 22 pre-existing skipped tests, before the final structured-output refinement; affected suites were rerun afterwards. Tests exercise self-review refusal, invented references, uncertainty, unchanged profile versions, API input checks, source recovery and preservation of Commons request defaults.

Live enrichment and source verification are operational evidence, separate from fixture benchmarks and OpenMythos certification. Never turn a heuristic score, coauthorship, model agreement or a healthy container into a claim of scientifically verified individual mastery. Only evidence-supported capabilities may enter governed review; unresolved capabilities remain tentative or are revoked with a reason.
