# ADR 0003: Closing the learning cycle — dream state, Commons, autonomy, all measured before they act

Status: accepted 2026-09-23 (operator), parts live in shadow on production since 2026-09-24.

## Context

By 2026-09-23 Djimitflo had the organs of a learning system but not the cycle. Measured on production:

- **Memory was write-only.** 67 promoted memories (38 engineering rules); no panel, refinement, checker or Commons decision
  read any of them. Only the maker got its top-3 similar local runs.
- **No fitness signal.** SEGML failed 408/408 cycles (no OpenMythos eval run; a missing column). The legacy dream ranking
  produced 232 "Evaluate capability X" proposals, none acted on. Skill evolution tables were empty.
- **Commons produced noise.** ~250 messages/day, 3 of 4 residents on a 3B model, verbatim echoes, the same knowledge gap
  re-discussed 264 times, and every proposed improvement parked in `needs_grounding` (a status nothing consumed).
- **The execution path failed on the platform, not on the proposals.** Root-owned `.git` after a deploy, new files invisible
  to reviewers, a dropped JSON brace, lockfile install noise, reviewers without dependencies — each found by hand.

## Decision

One cycle, with real outcomes (verified / regressed, checker verdicts, the operator's approvals) as the only fitness signal:

`observe → judge (TypeSafe, ADR 0002) → decide in code → act → outcome → memory → read back into the next decision`

Every new piece follows the same rollout, so nothing acts before it is measured:

1. **Shadow** — record what it would decide (`judgments` table), change nothing.
2. **Measure** — agreement with the final outcome per judgment on `GET /api/self-improvement/funnel` (`judgments[]`).
3. **Act** — a separate flag, switched on by the operator only.

| Part | What it does | Flag (default off) | Acting flag (operator) |
|---|---|---|---|
| Decision context (E8) | promoted memories, reranked by TypeSafe, as advice in the specialist panel | `TYPESAFE_DECISION_CONTEXT_MODE=shadow` | `…=enforce` |
| Dream state (E11) | replay failed runs, classify the cause (`failure_cause`), consolidate recurring causes into engineering-rule memory candidates | `DREAM_STATE_ENABLED`, `TYPESAFE_FAILURE_CAUSE_MODE=shadow` | `DREAM_STATE_PROPOSALS_ENABLED` (grounded fix proposals) |
| Commons (E9) | discuss each gap once, echo guard, evidence pack, agenda from real failures, contribution + idea judgments | `COMMONS_EVIDENCE_PACK_ENABLED`, `COMMONS_AGENDA_FROM_FAILURES`, `TYPESAFE_COMMONS_*_MODE=shadow` | `NEEDS_GROUNDING_TRIAGE_ENABLED` (route/archive parked ideas) |
| Autonomy (E3) | record "would auto-approve" on every loop approval (conservative rule-v1) | `AUTONOMY_SHADOW_ENABLED` | auto-approval itself: only after ≥20 measured approvals with ≥90 % agreement, explicit operator decision |
| Dead weight (E14) | SEGML and the legacy dream ranking off | `SEGML_ENABLED`, `DREAM_CYCLE_LEGACY_ENABLED` to restore | — |

Hard rules carried over from ADR 0002 and the masterplan: facts in code, fail-open, never a security boundary, reviewers never
run on dependencies the maker controls, human approvals in Djimitflo are never given on the operator's behalf.

## Consequences

- The platform fixes of this week (#332, #334, #338, #344, #347) are exactly what the dream state should now propose itself;
  the cause → component map lives in `dream-state-service.ts` (`CAUSE_TARGETS`) and grows with each new diagnosis.
- More shadow rows and a few more model calls per day; the agreement numbers decide what gets promoted.
- Next (plan E10, E12, E13): skills from verified runs, a niche archive with bandit selection, and an evolve-loop that runs
  several makers on one function with tests + mutation score as fitness.
