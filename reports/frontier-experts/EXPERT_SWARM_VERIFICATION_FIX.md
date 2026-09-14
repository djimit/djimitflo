# ExpertSwarm / Judge verification fix (spec §21, §20, §22)

## Defect (reproduced)

- `JudgeService.determineVerification()` can only return `contradicted | pending | unverifiable`.
- `ExpertSwarmOrchestrator.dispatch()` stored knowledge only when `verdict.verification_status === 'verified'` → unreachable; `knowledge_updated` always `false`.
- Even if reached, `storeKnowledge()` used `memory_type = 'expert_knowledge'`, which the `memory_candidates` CHECK constraint rejects; the failure was swallowed.
- The existing test asserted the broken behaviour (`knowledge_updated === false` under the title "stores knowledge when score >= 60") inside a `describe.skip` suite.

Failing regression test written first: `packages/server/src/__tests__/expert-swarm-verification.test.ts` (offline adapters injected through a new `ExpertSwarmDeps` constructor parameter; no network).

## Semantics chosen (no threshold weakened)

- New `PromotionDecision` on `JudgeVerdict`: `VERIFIED_FOR_USE | HUMAN_REVIEW_REQUIRED | CONTRADICTED | INSUFFICIENT_EVIDENCE | UNVERIFIABLE`, computed by `decidePromotion(score, contradictions, answers)`:
  - contradictions → `CONTRADICTED`
  - no answer with a real source and evidence refs → `INSUFFICIENT_EVIDENCE`
  - heuristic score ≥ 50 → `HUMAN_REVIEW_REQUIRED`
  - otherwise `UNVERIFIABLE`
  - **The heuristic never returns `VERIFIED_FOR_USE`** (I14): that state is reserved for an external checker or human decision recorded later.
- `verification_status` is unchanged for backwards compatibility (`okf-knowledge-updater`, `explainer-critic`, `segml` consumers still pass).
- `dispatch()` records a **governed candidate** only for `HUMAN_REVIEW_REQUIRED`: `memory_candidates` row with `memory_type='operational_memory'`, `store='semantic'`, `status='review_required'`, `promotion_status='blocked_pending_human'`, `human_required=1`, `source_ref='expert-swarm:<run id>'`, and metadata carrying run id, topic, version, judge verdict id/score/kind/decision, per-answer source + evidence refs + URL, `promotion_allowed:false`. Result gains `promotion_decision` and `knowledge_candidate_id`; `knowledge_updated` now means "candidate recorded", never "promoted".

## Evidence

```
cd packages/server
npx vitest run src/__tests__/expert-swarm-verification.test.ts src/__tests__/judge-service.test.ts src/__tests__/expert-swarm-orchestrator.test.ts
→ 16 passed | 12 skipped (the 12 skipped are the pre-existing network-only cases)
npx tsc --noEmit → clean
```

Tests prove: heuristic judge never yields `verified`/`VERIFIED_FOR_USE` even on four high-confidence evidenced answers; evidence-backed output lands as a `review_required` candidate with provenance; contradicted (opposite claims across domains from one adapter) and evidence-free output record no candidate; no row is ever `promoted` by the swarm.

## Files

- `packages/server/src/services/judge-service.ts` (PromotionDecision, decidePromotion, emptyVerdict)
- `packages/server/src/services/expert-swarm-orchestrator.ts` (deps injection, governed storeKnowledge, result fields)
- `packages/server/src/__tests__/expert-swarm-verification.test.ts` (new)
- `packages/server/src/__tests__/expert-swarm-orchestrator.test.ts` (misleading expectation replaced)

Capability status: **PROVEN** (offline integration tests through the real orchestrator, judge and registry).
