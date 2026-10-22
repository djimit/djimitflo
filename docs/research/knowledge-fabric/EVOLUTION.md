# DKF-EVOLUTION-001: evolution of knowledge (Phase G, design only)

Status: design only. Nothing here changes a loop, flag or population. It reuses the experiment machinery Djimitflo
already has, and adds no new optimiser.

## 1. The loop, mapped onto existing infrastructure

| Step | What varies or happens | Existing component | Status today |
|---|---|---|---|
| **Demand** | Where knowledge is missing | `knowledge_gap` judgments (`S/services/knowledge-gaps.ts`, `KNOWLEDGE_GAP_MODE=shadow`) | 13 open gaps (failure signatures), 16–19 Oct. `knowledge_gaps` table 0 rows |
| **Variation** | (a) new or edited KB pages, made by a human or an OpenKB compile in the vault; (b) normaliser variants (chunking, contextual prefix); (c) retrieval policy (arms B / C / D, filters, k); (d) memory-rule and skill-card candidates | vault git history; `retrieval-eval.ts` arms; `memory_candidates`; `skill_cards` (102 candidates, 0 consumers) | (a) static since 2026-09-12; (b) none; (c) one policy, B; (d) running |
| **Exposure** | Which knowledge reaches which decision | `kb_retrieval` judgments (subject = panel or committee); `memory_access_log`; `maker_genomes.knowledge_refs_json`; `self_improvements.evidence_refs_json` | 142 retrievals in 30 d; 0 proposals carry `kb:` refs |
| **Selection signal** | Did that knowledge help? | **Human labels** (E1 / E-KB / #835 cards); **knowledge fitness K1** (`S/services/knowledge-fitness.ts`: maker-attributable outcomes only, min n 5, half-life 30 d, 90 d window; statuses used_with_value / used_no_value / unused / insufficient); `outcome_credits` kinds | labels 0; knowledge credits 0. L3 v2: about 44 % of non-verified outcomes are reviewer or environment noise, so outcome credit **cannot discriminate yet** |
| **Experiment control** | Registration, WIP limit, stop dates | `S/services/experiment-registry.ts` (WIP 4 on oracle goals); pre-registration with sha256 (DI-001, MAKER-DEPS-001, EPOCH1-TRIAL-PREREG) | in use |
| **Retention** | Keep, demote or forget | OKF `status` (draft / stable / deprecated) plus `djimit.superseded_by`; `memory_candidates.status`; NE registry for falsified approaches | OKF status unused on KB; NE has 12 entries (+ NE-013 in #959) |
| **Negative memory** | Never re-propose a falsified approach | `docs/research/negative-evidence/NEGATIVE_EVIDENCE.yaml`; `negative-evidence-check.ts` (`NE_GENERATOR_CHECK_MODE=shadow`) | running in shadow |

The loop closes **only through labels** for now. Outcome-based fitness becomes usable for knowledge only after the
outcome oracle has an independent negative class (DI-001 LABELS.md: 0 of 128 oracle failures).

## 2. Selection rules (to pre-register per experiment, not globally)

1. **Unit of selection = retrieval policy first, pages second.** A policy (arm C versus B) is evaluated on frozen labels
   (EVALUATION_PROTOCOL.md). Page-level fitness (K1) is only descriptive until n ≥ 5 maker-attributable outcomes per page.
   K1's own minimum applies, and today no page reaches it.
2. **Promotion of a page** from `unverified` to `human-reviewed` (OKF v0.2 tier) needs a `human:` actor in `verified[]`.
   It is never derived from usage or fitness. Usage is a liveness signal, not trust (OKF v0.2 §5.1 says the same about
   `usage_count`).
3. **Demotion.** A page goes to `status: deprecated` when it is superseded, when `stale_after` passes without
   re-verification, or when it is labelled "does not help" on ≥ 3 independent queries. It is never deleted; it is
   tombstoned (ARCHITECTURE.md §2).
4. **Falsified approaches go to the NE registry** with a `reopen_condition`. Candidates that this audit already suggests:
   - the Qdrant `djimitflo_swarm` context path (dead: dimension mismatch, embedder 404; L3 F5);
   - the `kb_passage_relevance` enforce gate, if and only if E-KB rejects it;
   - "knowledge credit from outcome attribution", INSUFFICIENT until the oracle has negatives.

   Each entry needs its own evidence PR. None is added here.

## 3. Goodhart guards

| Risk | Guard | Where it already exists |
|---|---|---|
| Optimising what is retrieved instead of what helps | Retrieval frequency never enters fitness as a positive term. K1 distinguishes used_with_value from used_no_value | `knowledge-fitness.ts` statuses |
| LLM-graded fitness | Only executed verifiers, merge survival, deterministic policy and operator labels count. jev and LLM labels are never eligible | NE-001, DI-001 LABELS.md, E1 protocol |
| No counterfactual | Keep a **retrieval holdout**: a fixed share of panels gets arm A (no KB). This is the `MEMORY_HOLDOUT_RATE=0.3` pattern. Without it, "panels that cite KB do better" is confounded (F4: 44 of 52 panels cite KB, decision mix unchanged) | `assignment-context.ts:28-37` (memory) |
| Labels drift toward what the system shows | Blind labelling: no score, arm or source shown. Labels are frozen with a sha before analysis | `e1-retrieval-labels.ts` payload contract |
| The producer grades itself | The component that generates or compiles a page cannot be its evaluator. OpenKB-compiled pages start `unverified` | OKF v0.2 `generated` ≠ `verified` |
| Unit inflation reads as growth | A dedupe report comes before any count-based fitness. Frontier Experts had 2.6× inflation (4 708 units → about 1 769 works) | plan K / FE dedupe item |
| A single trust score gets gamed | The six trust assessments stay separate, and gates are boolean (SECURITY.md §2) | design |
| Repeated testing on one holdout | Each holdout is read once per registered protocol (the JC-001 / D5-NO practice). A new question needs fresh labels | experiment registry practice |
| Proxy improves while outcomes do not | Every knowledge experiment names a downstream check it does **not** optimise on: panel verdict distribution and verified rate. It is reported descriptively | design |

## 4. Changing the embedding model (an experiment, not a refactor)

UX-21 found three embedding spaces in use: nemotron 2048 for KB and proposals, nomic 768 for experiences and the
Qdrant swarm, snowflake 384 for memory-sync, the reasoning bank and the explainer. `kb_pages.embedding_model` is NULL on
every row. Rules for any change:

- Backfill `embedding_model` / `embedding_dim` from the code path first. Do not re-embed; this is a metadata fix.
- A new model runs as a shadow index next to the current one, on the same frozen S1 queries. It is compared with
  ΔMRR / recall@5 under the same decision rule as C versus B.
- It is promoted only on a CI lower bound > 0. Cost and latency must be non-inferior. For private corpora the model must
  be local (SECURITY.md §0.3).
- `VECTOR_STRICT_DIM` stays as it is. A cross-space query is a bug to fix at the source, not a resampling problem
  (`vector-memory-service.ts:333` strides mismatched vectors).

## 5. Realistic cadence

| When | What | Blocking input |
|---|---|---|
| Now | E-KB (#961) and S1 labels: ≈ 4 h of operator labelling in total | operator labelling time |
| After both | First policy selection, C versus B (one readout) | frozen protocol sha |
| Monthly | Page demotion pass: stale, superseded, or "does not help" ≥ 3 | labels accumulate |
| When the oracle has a negative class | K1 page fitness becomes a selection input | DI-001 oracle work |
| Never automatic | Promotion to `human-reviewed`, classification downgrade, NE entry | operator |
