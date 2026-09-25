# Frontier Expert Intelligence — Architecture Baseline

Date: 2026-09-13 · Branch `feat/frontier-expert-intelligence` (base main `ab9a8fb1`) · System layer: `.codex/frontier-expert-intelligence.md`.

Repository truth as inspected before any change. Every statement below cites a file; nothing is inferred from the prompt.

## 1. Existing primitives to extend (not duplicate)

| Primitive | Location | What it does today | Reuse decision |
|---|---|---|---|
| `ExpertSwarmOrchestrator` | `packages/server/src/services/expert-swarm-orchestrator.ts` (174 lines) | `dispatch({topic, domains[], maxParallel, sources})`: per domain one adapter search (`registry.searchAll("${topic} ${domain}", sources, 3)`), keeps the single best-confidence result as an `ExpertAnswer`, judges all answers, stores history in `expert_swarm_history`. | Integration point for expert resolution (§15). Keep `domains[]`; add `expertSelection` later. |
| `JudgeService` | `packages/server/src/services/judge-service.ts` (314 lines) | Heuristic triage: evidence/source/consistency/uncertainty sub-scores → logistic score 0-100, `score_kind: 'heuristic'`, lexical contradiction detection (`extractClaims` splits on sentence punctuation, `areOpposite` = negation-mismatch + character-trigram similarity), `verification_status` ∈ {contradicted, pending, unverifiable}; calibration table `judge_calibration` with ECE. | Keep as heuristic (§20). Promotion decision added separately (see fix report). |
| `SkillService` | `packages/server/src/services/skill-service.ts` | Skill files with `draft/validated/failed` trust levels, `validate()` in process or docker sandbox, `getSkillForFinding(topic, domain)`. | Reuse for §34 analysis skills. |
| `KnowledgeAdapterRegistry` + adapters | `packages/server/src/services/knowledge-adapters/` (`wikipedia`, `arxiv`, `okf`, `djimitkb`, `adapter-cache`) | `KnowledgeSourceAdapter {search, fetch, isAvailable}`, `KnowledgeResult {id,title,content,source,url,confidence,metadata}`, cached `searchAll`. | Evidence retrieval backbone; arXiv adapter = Tier-1/2 evidence source. New adapters (e.g. Pacing the Frontier, OpenAlex) plug in here. |
| `KnowledgeRuntimeService` | `packages/server/src/services/knowledge-runtime-service.ts` (714 lines) | `health()`, `syncCapabilities()`, `closeLoop()`, `readOkfSpecialistProfiles()`, `resolveEvidenceRef(ref)` → `{kind, exists, valid}`. | Evidence-ref validation for claims; OKF specialist profiles are the closest existing "expert" notion. |
| `memory_candidates` | `packages/server/src/database/migrate.ts` L816 | CHECK-constrained governed memory: `memory_type ∈ {operational_memory, engineering_rule, policy_rule}`, `status ∈ {candidate, review_required, rejected, promoted}`, `promotion_status ∈ {proposed, blocked_pending_review, blocked_pending_human, rejected, promoted}`, `human_required`, `sensitivity`. | The governed promotion queue (§22). |
| `knowledge_claims` | `migrate.ts` L1748 | `agent_id, topic, claim, confidence, evidence_json, status, votes_json` — flat agent claims, no subject/relation/object, no polarity or temporal scope. | Too flat for §17; a dedicated `expert_claims` table is justified (see DATA_MODEL.md). |
| `specialist_panels` / `specialist_reviews` | `migrate.ts` L847/L866 | Panel + per-specialist stance/confidence/evidence reviews with reviewer actor. | Candidate home for independent perspectives + checker separation (§16, I06). |
| `swarm_capabilities`, `capability_tokens` | `migrate.ts` L1001/L957 | Capability registry with kind/status/risk ceiling; capability tokens for execution authority. | Capability taxonomy (§7) should register as `swarm_capabilities` rows, not a parallel table. |
| `swarm_claims` | used by `agent-communication-service.ts` | Typed claims (`claim_type`, `predicate`, `subject_ref`, `evidence_refs_json`, `status`) incl. `gap` predicate consumed by the Agent Commons. | Gap claims feed expert questions; expert claims link back via `evidence_refs`. |
| Audit | `AuditService` (`audit_events`, `audit_logs`) | Structured audit records with `event_type`, `action`, `resource`. | Lifecycle transitions (§9) must write here. |
| Runtime profile / flags | `config/runtime-profile.ts`, env `DJIMITFLO_*` | Autonomy gated by `DJIMITFLO_RUNTIME_PROFILE`. No generic `*_ENABLED` convention found by grep. | Introduce `DJIMITFLO_FRONTIER_EXPERTS_ENABLED` (§38). |

## 2. Defects found in the baseline (P0)

1. **Verification dead end (spec §21) — CONFIRMED.** `determineVerification()` returns only `contradicted | pending | unverifiable`; `dispatch()` gated storage on `verification_status === 'verified'` (line 78 before the fix). `knowledge_updated` was therefore always `false`.
2. **Storage would have failed anyway.** `storeKnowledge()` inserted `memory_type = 'expert_knowledge'`, which violates the `memory_candidates` CHECK constraint; the error was swallowed by `catch { /* best-effort */ }`.
3. **Weakened test expectation (spec §40 violation).** `expert-swarm-orchestrator.test.ts` had `it('stores knowledge when score >= 60')` asserting `knowledge_updated === false`, and the whole suite is `describe.skip` (network), so the swarm had zero executed coverage (`13 passed | 12 skipped`).
4. **Single-source-per-domain.** The orchestrator keeps only the best-confidence result per domain, so two sources for one domain can never contradict each other; contradictions only surface across domains. Documented; addressed by the claim × evidence model later (§17).

Fix and evidence: `EXPERT_SWARM_VERIFICATION_FIX.md`.

## 3. Divergences from the spec's assumptions

- There is no `ExpertResolver`, no expert identity/evidence/claim tables, no capability taxonomy for experts; `OKF specialist profiles` and `specialist_panels` are the nearest concepts.
- `knowledge_claims` exists but is agent-vote oriented; not reused for expert claims.
- Feature flags are env-based per feature, no registry.

## 4. Commands

```
cd packages/server
npx vitest run src/__tests__/expert-swarm-verification.test.ts src/__tests__/judge-service.test.ts src/__tests__/expert-swarm-orchestrator.test.ts
# before fix: 13 passed | 12 skipped (no verification coverage); after fix: 16 passed | 12 skipped
npx vitest run src/__tests__/okf-knowledge-updater.test.ts src/__tests__/explainer-critic-judge.test.ts src/__tests__/segml-judge-updater.test.ts   # 16 passed
```
