# G53 independent completion-gate review and correction

## Executed finding

`loop-verification-independent-highrisk.log` uses the actual LoopService and SQLite schema/migrations with synthetic in-memory run/lease records and a nonempty finding. Existing readable assignment paths satisfy the file-presence prerequisites; no maker or reviewer runtime is dispatched. High-risk classification is explicitly true.

- One completed/reviewed maker plus another prepared, running, failed or cancelled maker incorrectly returned ready_for_human_merge and certified:true. Security gate also passed while the second maker had no completed review.
- Zero completed makers incorrectly returned certified:true because empty-array every checks passed; run remained verifying.
- Verification overwrote cancelled and completed run statuses with ready_for_human_merge. A cancelled run with all leases previously reviewed could subsequently complete with a synthetic approval reference.
- Existing completeLoopRun independently blocked incomplete leases: no actual merge or completion of incomplete work was proven.
- A fully reviewed retry could pass verification yet fail completion because completionBlockingLeases excluded old ordinary checkers but not old security checkers of superseded makers.

The earlier `loop-verification-independent-probe.log` used empty findings; metadata high risk alone did not make that fixture's security gate high-risk. The second log is the relevant explicit high-risk proof. Originals are retained.

## Minimal correction

- Explicit maker_completion gate requires at least one active maker and every non-superseded maker completed.
- Pending/running work remains verifying; failed/cancelled maker work blocks. Neither can certify or become ready merely because a subset completed.
- Certification additionally requires ready_for_human_merge or completed status plus passing required gates.
- Cancelled/completed run statuses survive verification. Cancelled completion is refused and mapped to HTTP409. Completed completion is idempotent and preserves the original approval/timestamp/events.
- Completion filtering now treats superseded security checkers consistently with superseded ordinary checkers.
- Existing independent review-evidence checks, risk provenance, completion counterguard and first-completion human approval remain intact.

## Verification

`loop-completion-red-tests.log`:9 failed assertions /1 passed before implementation. New tests cover incomplete-maker statuses, no completed makers, absent makers, cancelled/completed lifecycle, high-risk positive control, human approval preservation, superseded security reviewers and HTTP409.

`loop-completion-green-tests.log`:107 passed /1 existing skipped across five files, including11 new completion tests and the existing security-checker/service suites. Server type-check, scoped ESLint and git diff --check passed. Source frozen after these checks.

## Probe boundary and limitations

The initial ad-hoc in-memory completion probes called the existing fire-and-forget experience.indexRun side effect. Subsequent source inspection showed that this may attempt Ollama embedding and Qdrant indexing against configured/default external services. No worker/model execution was observed; external embedding/index outcomes are UNKNOWN. The only possible embedding prompt was the synthetic run ID, not repository content or credentials. Do not interpret the original probe's shorthand no-provider scope label as proof that no background embedding request was attempted.

The new regression file explicitly stubs only ExperienceRetrievalService.indexRun; the actual LoopService, verifier, routes, SQLite and gate state are exercised. No production service, provider configuration, deployment, merge or persisted local audit task was changed by this correction.
