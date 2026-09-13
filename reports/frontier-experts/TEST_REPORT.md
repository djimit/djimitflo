# Test report (§41, §61)

Branch `feat/frontier-expert-intelligence` at 417da47f (base main ab9a8fb1). Run 2026-09-14 00:51 CEST on macOS, Node 22.23.2, vitest 4.1.11.

## Commands and results

```bash
cd packages/server && npx vitest run                       # full server suite
# Test Files  356 passed | 2 skipped (358)
# Tests       2662 passed | 20 skipped (2682)   0 failed   35.84 s

cd packages/server && npx tsc --noEmit -p tsconfig.json    # clean

cd packages/server && npx vitest run \
  src/__tests__/expert-swarm-verification.test.ts src/__tests__/judge-service.test.ts \
  src/__tests__/frontier-expert-invariants.test.ts src/__tests__/expert-perspective-security.test.ts \
  src/__tests__/expert-resolver.test.ts src/__tests__/expert-council.test.ts \
  src/__tests__/pacing-frontier-ingestion.test.ts src/__tests__/expert-evidence-enrichment.test.ts \
  src/__tests__/expert-resolution-benchmark.test.ts src/__tests__/expert-e2e-scenario.test.ts
# Test Files  10 passed (10)   Tests  43 passed (43)

cd packages/server && npx tsx src/scripts/expert-resolution-benchmark.ts   # exit 0 = hard gates pass
cd packages/server && npx tsx src/scripts/expert-e2e-scenario.ts           # exit 0 = 17/17 §59 checks
```

The two skipped files are pre-existing: `expert-swarm-orchestrator.test.ts` (12 tests, `describe.skip`, needs live wikipedia) and `controlled-runtime-improvement.test.ts` (1). The behaviour the legacy orchestrator file would have covered is exercised by `expert-swarm-verification.test.ts`, `expert-council.test.ts` and `expert-e2e-scenario.test.ts`, none of which is skipped.

## Test pyramid coverage (§41)

| layer | file | tests | what it proves |
|---|---|---|---|
| reproduction / fix | expert-swarm-verification.test.ts | 3 | §21 dead end reproduced; promotion_decision separate from score; governed candidate (review_required, human_required) |
| unit | judge-service.test.ts | existing + promotion cases | decidePromotion never VERIFIED_FOR_USE; contradictions → CONTRADICTED (I14) |
| invariant | frontier-expert-invariants.test.ts | 5 | I01 signature ≠ expertise, I02 evidence required, I03 ambiguous fails closed, I06 checker ≠ approver, I07 provenance, I08 contradiction blocks, I12 versions auditable, retraction → STALE |
| adversarial / security | expert-perspective-security.test.ts | 3 | no persona prompt, external content quoted inert (I04, I05), impersonation output rejected (I09), unknown evidence refs dropped (I15) |
| unit / property | expert-resolver.test.ts | 5 | capability matching, I13 fame vs relevance, Goodhart resistance (duplicate origins), diversity, AS OF reproducibility, abstention (§53) |
| integration | expert-council.test.ts | 3 | independent perspectives (§16), claim graph SUPPORTS/CONTRADICTS (§17), disagreement preserved (§19), adversary (§57), orchestrator integration under flag / force, CONTRADICTED blocks queue (I08) |
| ingestion | pacing-frontier-ingestion.test.ts | 3 | parser on the real page structure, idempotent ingestion, DISCOVERED only, anonymous skipped |
| enrichment | expert-evidence-enrichment.test.ts | 4 | Atom author view parsing, Tier-1 attachment + capability inference with evidence refs, ambiguous fails closed (I03), unmatched stays DISCOVERED (I10), bounded batch |
| benchmark / calibration | expert-resolution-benchmark.test.ts | 3 | ≥25 in-domain queries over 12 families; §44 hard gates all zero; improvement vs naive baseline on P@3, R@3, NDCG, primary ratio, false-expert, unsupported attribution, contradiction detection; abstention quality |
| skills | frontier-expert-skills.test.ts | 2 | 14 §34 skills install idempotently and validate through SkillService; procedure reaches the perspective prompt without weakening no-persona rules |
| routes | expert-routes.test.ts | 2 | list/filter/resolve/detail; transition needs an operator (agents 403), registry guards map to 409, council flag-gated and abstains without runtime |
| mcp | packages/mcp-server/src/__tests__/expert-tools.test.ts | 2 | search/get/capabilities/claims read-only; honest error when tables are absent |
| end-to-end | expert-e2e-scenario.test.ts | 1 (17 checks) | §59 reference scenario on the frontier path with a scripted evidence-bound model; impersonating perspective surfaced and claim-free; run history stored |

Total frontier-specific: 13 files, 49 tests, 0 skipped (server 47 + mcp-server 2) after commit 0099b19d; the full-suite numbers above include the routes and skills tests (mcp-server suite runs separately: `cd packages/mcp-server && npx vitest run`). Nothing was weakened: the misleading `describe.skip` assertion that once encoded the dead end was replaced by a live assertion in `expert-swarm-verification.test.ts`.

## Not covered by automated tests

- Live arXiv transport (BLOCKED, GAP_REGISTER G-01) — parser and service logic are covered offline.
- Live model perspectives (BLOCKED, G-02).
- Dashboard, MCP, skills (not built, G-06).
