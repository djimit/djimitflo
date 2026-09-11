# E4/E5: bounded self-improvement learning closure

## Actual reconstructed chain

`SelfImprovementService` creates a proposal and specialist panel. Independent panel consensus and an operator decision precede `AutonomousGoalGenerator.generateImprovement`, which creates one canonical `goals.improvement_id` link and marks the proposal executing. Loop completion can mark a settled linked improvement verified; a no-findings completion can mark no_change. `KnowledgeRuntimeService.closeLoop`, reachable through the existing swarm evolution API and loop daemon, creates a deterministic loop-learning evaluation, reflection, memory candidate and conditional follow-up WorkItem.

Before this correction, closure never joined those artifacts back to the improvement. No production caller transitions an improvement to evaluating or invokes `completeImprovement`; therefore the apparently defined applied/regressed outcome chain was not operational. The structural evaluator measures maker/checker/gate/evidence completeness and retry count, not a measured change in product value.

## Executed defect and correction

An isolated migrated SQLite fixture with a cancelled run and old completed maker/checker rows returned `closed` and emitted learning artifacts. `self-improvement-closure-red.log` captures the actual failed assertion. The initial additional multi-maker test happened to pass because its unfinished lease was selected first; this is not represented as a second red reproduction. The original source selected only the first nonsuperseded maker, so the correction checks all active workers independently of row order.

The existing closure boundary now checks before new writes **and before replaying an existing closure**:

- reviewed terminal run state (completed or ready_for_human_merge), no operator pause;
- every active nonsuperseded worker completed and every maker paired with accepted checker evidence;
- the existing `LoopVerificationService.hasAcceptedReviewEvidence` contract, reused through a visibility-only change, including runtime exit/cancel/timeout/read-only/stdout/contract proof;
- required high-risk security checker evidence and only pass/skipped gates, with at least one actual passing gate;
- existing trace/checkpoint/runner-manifest completeness requirements.

Blocked replay preserves the historical closure/evaluation rows; it does not erase evidence or advertise the old closure as currently valid. Manual review remains the existing explicit supported authority path. Structural test fixtures now declare manual checker reviews rather than disguising accepted strings as successful mock runtime proof. These seeded fixtures do not certify authenticated human review or native provider execution.

For a completed run linked to a completed goal, with all linked runs completed and its canonical improvement already verified, actual closure evidence now advances the improvement to **evaluating**, atomically appending loop/eval/reflection references. An earlier ready-for-human-merge closure does not advance the improvement; later replay after completion can bind the existing artifacts without duplicates. No automatic merge, application, promotion or outcome classification is added.

## Verification and scope

Initial focused run: 29/29 across learning closure, self-improvement and assurance tests. Final expanded run: **70/70 across six files** (19:51 local, 3.68 seconds), in `self-improvement-closure-green.log`, covering those services plus knowledge-runtime, loop security checking and verification completion. Cases include cancellation, replay after cancellation, incomplete maker, unresolved gate, missing security review, operator pause, legacy runtime proof rejection, immutable historical rows, evidence-linked transition, idempotency and atomic rollback when historical evidence references are malformed. Server type check, scoped ESLint and `git diff --check` passed. All database and worker states are disposable local fixtures; no provider or external service was invoked.

An additional exact red regression (`self-improvement-empty-findings-risk-red.log`) found that `isHighRiskRun` ignored run-level high risk when findings were empty. The parent authorized the central correction: `isHighRiskRun` now checks its existing `highRiskReason(run)` before iterating findings, retaining goal risk and finding-sensitive classification. The temporary closure composition was removed; all callers use the same fixed helper. Two direct high/critical classification regressions failed before this change (`shared-loop-risk-red.log`) and now prove verification requires its security review even with empty findings. Low-risk empty runs, finding-derived risk and linked high-risk goals retain their intended classification. Final rerun **73/73 across six files**, server type check, scoped lint and diff check passed (`shared-loop-risk-green.log`, 19:53 local).

Source ownership: `knowledge-runtime-service.ts`; one private-to-public helper change in `loop-verification-service.ts`; the bounded `isHighRiskRun` correction in `loop-service.ts`; `learning-closure-service.test.ts` and three direct/caller regressions in `loop-security-checker.test.ts`. Existing unrelated changes in those files are preserved. No outcome-learning or cognitive-loop source was edited here.

## Remaining limits: E4 PARTIAL; E5 not intelligence proof

- Applied/regressed still require evidence-bound product outcome assessment; structural score deltas are not that evidence. `SelfImprovementService.completeImprovement` remains a dormant service method with no production caller and only an evaluating-state precondition, so it must not be used as measured-success certification.
- The existing no_change path means a scan found no required changes, not measured equivalence between deployed outcomes.
- Closure reflections/memory candidates are candidates; this change does not prove a later strategy actually used them or improved outcomes. Cognitive strategy/statistics work and outcome assessment scheduling are separately owned tranches.
- This boundary validates recorded current proof, not a fresh rerun of all code checks, nor deployment provenance. Historical loop-learning scores remain structural diagnostics, not causal evaluations.
