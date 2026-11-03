# ADR 0002: TypeSafe System One as the judgment layer, shadow first

Status: accepted 2026-09-22 (operator), three judgments in shadow on production since 2026-09-23.

## Context

Djimitflo used LLMs for three different jobs at once: generating text (proposals, code), judging (panel reviews, checker
verdicts) and routing (which proposal goes where). Judging with a generative model is slow, costly and inconsistent:
2,217 specialist reviews in the week to 2026-09-23 for 1 verified run, and the automatic checker was often the same model
family as the maker.

TypeSafe (docs.typesafe.ai) serves System One models (Jev) that answer typed questions about a state: Noul (P(yes)),
Choice (option + probabilities + confidence) and Score. Answers come back in ~150 ms at a fraction of an LLM call, with a
per-question standard deviation around 0.01 over repeats. Known limits (jev-1.13 jaggedness): literal reading, weak at
counting, arithmetic and dates, steerable by injected instructions, no invariants across questions, no text generation.

## Decision

Code owns the control flow; TypeSafe answers narrow semantic questions that code then acts on. LLMs keep the work only
they can do (writing code and proposals, open reasoning).

Rules:

1. **Shadow before enforce.** Every judgment has its own flag `TYPESAFE_<JUDGMENT>_MODE=off|shadow|enforce` (default off).
   Shadow records what it would decide in `judgments` and changes nothing. Promotion to enforce needs measured agreement
   against real outcomes and an operator decision.
2. **Fail-open.** Any error (no key, HTTP error, breaker open) yields no judgment; the caller keeps its existing logic.
3. **Facts stay in code.** Existence of files, counts, arithmetic and dates are computed in code and passed to `decide()`
   as `facts`, never asked of the model (example: `namedPathsExist` in the proposal pre-screen).
4. **Never a security boundary.** A judgment may add a check, never remove one.
5. **Pinned model** (`jev-1.13.0`): aliases move, calibration does not.
6. **Minimal state.** Send only what the question needs (the checker opinion gets task, capped diff and checks, never the
   checker's own notes); secrets are redacted and state is capped before it leaves the host (`prepareState`).
7. **Confidence gates the decision.** Choice answers below confidence 0.6 are `uncertain`, which always means "keep the
   existing path".

## Current judgments

| Judgment | Question | Hook | Since |
|---|---|---|---|
| `proposal_prescreen` | 4 Nouls: names a path, verifiable by one command, concrete, touches a sensitive area | before the specialist panel | #321, #327 |
| `checker_second_opinion` | Choice accepted / needs_revision / rejected on task + diff + checks | after the LLM checker | #328, #334 |
| `reflection_triage` | Choice djimitflo_change / other_system / aspiration | when a proposal is parked in `needs_grounding` | #333 |

Calibration note: the four `checker_second_opinion` rows from 2026-09-23 18:03–18:05 saw an empty diff (new files were
invisible before #334) and must be excluded when measuring agreement.

## Consequences

- Every judgment is auditable and joinable to outcomes via `judgments.subject_type/subject_id`.
- A judgment can replace an LLM decision class only after its shadow agreement is measured; until then cost goes up slightly
  (TypeSafe calls) and nothing else changes.
- State leaves the host: TypeSafe is a third party. The redaction and cap in `prepareState` are the boundary; review what a new
  judgment sends before enabling it.
