# ACE — gap analysis and smallest vertical slice

Baseline: [CURRENT_STATE.md](CURRENT_STATE.md). Facts below are prod measurements recorded in the operator plan
(Phases SI, EP, CR, KE, IM, CP3); none are re-estimated here.

## 1. Constraints from measured facts

| Fact | Value | Consequence |
|---|---|---|
| Gym vs production, same species | atomic 80.8 % gym vs 5.7 % prod (3/53) | A gym win is not evidence of a production gain; ACE must judge in production arms |
| Merge survival | n = 2 settled | Deployment survival is INSUFFICIENT_EVIDENCE until ~19-10 |
| Holdout epochs | exhausted (11/10, 12/10) | No promotion until a fresh epoch (#753 enforces) |
| Memory rules (F3) | inconclusive, trend against | Do not assume memory helps |
| KB retrieval (F4) | cited, decisions unchanged | Being cited ≠ changing outcomes |
| K1 examples | 2 most recent verified paths | Recency, not similarity — cheapest retrieval experiment |
| Retrieval harness (UX-24) | trust tier dominates relevance | New retrieval needs a labelled set |
| Qdrant swarm path | dead | Use the working K2 embeddings instead |
| Power | ~50 oracle goals per arm per month | Only ≥ 20-point effects are detectable in a month |

## 2. Reuse vs build

| Stage | Reuse | Smallest build |
|---|---|---|
| Discover | discovery bus, scout, yield-gated interest profile (#733) | feed top failure signatures (#732) into scout terms |
| Understand | technique cards, claims, KB passage gate | none until a consumer exists |
| Analyse external software | shipped-code scan (parse-only) | none — see [REA_FEASIBILITY.md](REA_FEASIBILITY.md) |
| Reproduce / Benchmark | gym, graded fitness, paired tests, holdout exposure | fresh holdout epoch (operator) |
| Improve | genome registry, dream mutation, model selector | none; dormant by evidence, not by missing code |
| Integrate / Verify / Deploy | lanes, scope gate, checkers, runtime admission, auto-deploy + verdict | none |
| Learn | attribution, merge survival, memory holdout | arm assignment for retrieval (below) |

Not to build: a capability graph, a second discovery swarm, or a canary layer before one vertical slice shows a
production gain — each would add surface without a consumer (Ponytail rule in project instructions).

## 3. Vertical slice: ACE-001 as a production experiment

The directive's ACE-001 (memory and skill retrieval) fits existing parts with one small change.

- **Arms** (assigned by goal-id hash, like X1 and the memory holdout): A baseline; B K1 examples ranked by embedding
  similarity to the assignment instead of recency; C memory rules withheld (the existing holdout arm); D B + C.
- **Primary outcome:** verified rate of oracle-lane goals, outcome attribution applied (maker failures only).
- **Secondary:** tokens per goal, graded score, assertion-strength verdict, merge survival when settled.
- **Pre-registered rule:** promote B only with a paired difference ≥ 20 points and a 95 % interval excluding 0 at
  ≥ 50 goals per arm; otherwise keep recency. No arm may touch gates, checks or the evaluator.
- **Build:** one flag (`K1_SIMILARITY_ARM`, shadow → act), similarity via the existing K2 proposal embeddings, arm
  recorded on the lease and in the evolution evidence. Expected duration: one to two months at current volume.

## 4. Open questions (operator)

1. Fresh `GYM_HOLDOUT_EPOCH` before any genome trial resumes.
2. Whether ACE-001 runs alongside X1/F2 (shared goal volume lowers power for all three) or after X1 reaches target.
