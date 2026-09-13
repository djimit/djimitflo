# Final validation — Frontier Expert Intelligence (§60, §61)

Branch `feat/frontier-expert-intelligence` (base main ab9a8fb1, head af642fd2), 2026-09-14. Verdict: **NOT DONE by §60, hard gates PASS, no epistemic or security defect open; the remaining items are external blockers (arXiv rate limit, PR 223 model runtime) and P2 scope.**

## 1. Architecture changes

- Governed expert registry as the single owner of identities, evidence, capabilities, claims, lifecycle and versions (`FrontierExpertRegistryService`), behind flag `DJIMITFLO_FRONTIER_EXPERTS_ENABLED`.
- Query-dependent `ExpertResolverService` (visible weights, WHY_SELECTED, AS OF, abstention) feeding an `ExpertCouncilService` (independent perspectives, claim graph, disagreement, adversary) that the existing `ExpertSwarmOrchestrator` uses on its new frontier path; the legacy per-domain path is untouched.
- `JudgeService` now emits a `promotion_decision` separate from its heuristic score; the orchestrator stores a governed `memory_candidates` row only for HUMAN_REVIEW_REQUIRED (never promotes).
- Ingestion (`PacingFrontierIngestionService`) and enrichment (`ExpertEvidenceEnrichmentService` over the existing `ArxivAdapter`) advance identities at most to CAPABILITY_INFERRED; CHECKED/APPROVED/ACTIVE need distinct human actors.
- Perspective prompts are evidence-only, quote external content inert and are validated on output (`expert-perspective-builder`).

## 2. Files changed (non-test, non-report)

`.codex/frontier-expert-intelligence.md` · `packages/server/src/database/migrate.ts` · `services/judge-service.ts` · `services/expert-swarm-orchestrator.ts` · `services/frontier-expert-registry-service.ts` · `services/expert-perspective-builder.ts` · `services/expert-resolver-service.ts` · `services/expert-council-service.ts` · `services/pacing-frontier-ingestion-service.ts` · `services/expert-evidence-enrichment-service.ts` · `services/expert-resolution-benchmark.ts` · `services/expert-e2e-scenario.ts` · `services/knowledge-adapters/arxiv-adapter.ts` · `scripts/expert-resolution-benchmark.ts` · `scripts/expert-e2e-scenario.ts`. Ten test files and eleven reports (`reports/frontier-experts/`).

## 3. Database / schema

Ten new tables created in `runMigrations` (`createFrontierExpertTables`): expert_capability_taxonomy, expert_identities, expert_affiliations, expert_evidence, expert_capabilities (CHECK evidence_refs non-empty), expert_claims, expert_claim_relations, expert_versions, expert_lifecycle_events, expert_source_snapshots. No existing table altered; `memory_candidates` used as-is with `status = 'review_required'`. See DATA_MODEL.md.

## 4. Tests

See TEST_REPORT.md: full server suite 354 files / 2658 tests passed, 0 failed, 2 pre-existing skips; frontier-specific 10 files / 43 tests; `tsc --noEmit` clean.

## 5. Benchmark (baseline vs enhanced)

See EXPERT_RESOLUTION_EVALUATION.md (30 queries, K = 3, synthetic fixture): Precision@3 0.48 → 0.73, Recall@3 0.65 → 0.82, NDCG@3 0.47 → 0.80, primary evidence ratio 0.52 → 1.00, false-expert rate 0.47 → 0, unsupported attribution 0.47 → 0, identity-resolution error 0.36 → 0, contradiction detection 0 → 1, abstention quality 1 → 1. Regressions reported: perspective diversity 0.80 → 0.78, latency 0.43 → 0.65 ms/query, context ≈160 → ≈465 tokens.

## 6. Security

Threats tested (THREAT_MODEL.md, SECURITY_VALIDATION.md): prompt injection via evidence excerpts (quoted inert, no tool surface), impersonation in prompt and output (rejected, now surfaced as `rejected_perspectives`), fabricated evidence references (dropped, count reported), signature-only promotion (transition guard), self-approval (actor separation), system/ingestion actors promoting (blocked), ambiguous identity auto-promotion (fails closed). Hard gates §44 on the benchmark run: all six = 0, PASS.

## 7. Epistemic validation

Disagreement is preserved as CONTRADICTS relations with both evidence sides and a resolving observation; a disagreeing council forces CONTRADICTED and keeps knowledge out of the queue; uncertainties and falsification tests are carried per perspective; adversary attacks only persisted claims. The heuristic judge score is labelled `score_kind: 'heuristic'` and never yields VERIFIED_FOR_USE (I14). Absence of arXiv evidence leaves an identity DISCOVERED, never REJECTED (I10).

## 8. §59 reference scenario

`npx tsx src/scripts/expert-e2e-scenario.ts` → 17/17 requirements PASS (decomposition into 5 capability families incl. recursive_self_improvement, ai_security, ai_governance; 7 experts resolved with WHY_SELECTED; 6 independent perspectives; 12 evidence-backed claims; 3 agreements, 1 disagreement; 6 uncertainties; 2 adversarial attacks; judge CONTRADICTED; provenance for every expert; fabricated attribution dropped 6×; 1 impersonating perspective rejected; nothing promoted). Runtime: scripted evidence-bound fake model — a live-model run is BLOCKED (G-02).

## 9. Capability matrix

| capability | status |
|---|---|
| Repository truth / architecture baseline | PROVEN |
| ExpertSwarm/Judge verification dead end repaired | PROVEN |
| Provenance, claims, lifecycle, versions | PROVEN |
| Security & no-impersonation invariants (unit/integration) | PROVEN |
| Prompt-injection resistance with a live model | PARTIALLY_PROVEN |
| ExpertResolver (weights, WHY_SELECTED, I13, AS OF, abstention) | PROVEN |
| Council integration in ExpertSwarm (scripted runner) | PROVEN |
| Council with real model | BLOCKED (G-02) |
| Pacing-the-Frontier ingestion | PROVEN (real page, idempotent) |
| arXiv enrichment + capability derivation | PROVEN offline / BLOCKED live (G-01) |
| Full seed enrichment run | BLOCKED (G-01) |
| Benchmark + hard gates | PROVEN (synthetic) / NOT_PROVEN (live data) |
| §59 end-to-end scenario | PROVEN (scripted) / BLOCKED (live model) |
| Skills, MCP, UI, evolution/deprecation | NOT_PROVEN (not built, P2) |
| Production activation | BLOCKED (merge, flag, runtime) |

## 10. Remaining gaps

GAP_REGISTER.md, G-01 … G-10.

## 11. Commit-ready summary

Nine commits on `feat/frontier-expert-intelligence`, each with green tests; no change to existing behaviour unless the flag or `expertSelection.force` is set; PR to be opened against main once the user decides on PR 223 ordering (the council's model runner imports the provider module from that branch lazily and abstains cleanly when absent).
