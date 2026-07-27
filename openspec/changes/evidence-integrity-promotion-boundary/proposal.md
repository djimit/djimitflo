# Evidence integrity and promotion boundary

## Problem

Djimitflo can execute, evaluate and propose improvements, but two remaining
boundaries can turn text or synthetic data into false operational evidence:

1. runtime warning detection scans agent and tool content as if it were runtime
   diagnostics;
2. SEGML can append generated cases directly to the canonical OpenMythos corpus
   and currently reconstructs source cases from agent responses.

The self-modification scanner also reports uncalibrated heuristics as
actionable findings.

## Outcome

1. Runtime warnings carry source provenance and only diagnostics can block.
2. Maker runs distinguish changed work, evidenced no-change and failure.
3. SEGML stores draft cases only and preserves original corpus case lineage.
4. Canonical promotion remains owned by the existing governance feedback and
   OpenMythos lifecycle gates.
5. Self-analysis labels heuristic confidence and does not treat file size as
   measured complexity.
6. Judge transfer to code-loop decisions remains shadow-only until calibrated
   against actual outcomes.

## Non-goals

- No new orchestrator, evidence graph, scheduler or dependency.
- No JudgeService dependency in crash recovery.
- No automatic merge, deployment or benchmark promotion.
- No production database rewrite during implementation.
