# Execution approval review and queue-time admission revalidation

## Independent review

Parent-owned execution approval binding hashes canonical task instructions, selected executor, metadata, tags and referenced entity IDs; expired, legacy unbound, manual-action and superseded grants cannot substitute for current execution approval. The reviewed tests cover input changes, canonical JSON ordering, expiry, newer refusal and input/grant changes during a capacity wait. The retired-agent fixture initially failed on missing mandatory agent description/capabilities, not the retirement assertion; those fixture columns were corrected without changing that assertion. Preserved failing log: `execution-approval-independent-review.log`; corrected run: **69 passed / 3 files**, `execution-approval-independent-review-green.log`.

The review then found an actual remaining admission hole: after the asynchronous capacity wait, the engine compared task inputs and grant validity but reused the policy decision made before waiting. An isolated real-SQLite probe inserted a matching deny policy inside the capacity seam. The current policy evaluated to `deny`, yet the non-provider executor-start sentinel was invoked once. See `execution-approval-queue-policy-review.log`.

## Bounded correction

After capacity is acquired, the engine now reloads current task state, checks current agent availability and loop/recovery/assurance holds, requires the task still be queued, compares bound inputs, and reruns the existing classifier, policy evaluator and governance gate. It persists the new risk assessment and a `queue-admission` policy-decision evidence record containing both prior and current decisions. A current deny or missing required approval fails before executor start; no recursive dispatch or automatic approval is introduced.

An explicit queued-task cancellation/pause remains cancelled/paused when admission refuses it. Other failed admissions retain the existing capacity-release/failure path. The early evidence title now says **Execution admitted to queue**, not that execution has already started.

## Executed verification

- `queue-admission-red.log`: **7 failed / 14 passed** before the admission correction: new deny, new approval requirement, newly restrictive governance, queue cancellation/pause, and two newly established holds.
- `queue-admission-green.log`: **76 passed / 3 files**, including execution engine, approval binding and atomicity regression suites.
- `queue-admission-final.log`: **21 passed** focused binding/admission tests after adding explicit cancelled/paused-state preservation assertions and correcting the queue evidence label.
- Initial type-check rejected the new source label because `EvidenceSource` lacked `queue-admission`; preserved in `queue-admission-type-check-red.log`. An initially reported green was incorrect: the command combined type-check and lint, and its final exit code reflected lint. The shared union is now explicitly extended; separate shared build, server type-check and focused lint commands each exit 0 (`queue-admission-shared-build.log`, `queue-admission-type-check.log`, `queue-admission-lint.log`). Focused diff whitespace check: exit 0.

All policy/governance records are synthetic local fixtures; no real benchmark result, provider execution, deployment or approval was fabricated.

## Mutation scope restored

The approval transaction refactor moved decision guards beyond the old numeric Stryker range. The configuration now targets lines 122–145: boolean decision input, missing approval, expired/nonpending status, chronological expiry and maker/self-approval separation. The previous shifted-range result is not equivalent coverage.

`approval-range-mutation-final.log`: **71/71 killed**, comprising approval 37, ToolBroker 28 and Docker sandbox 6; zero survived, uncovered or errored mutants. The earlier historical implementation generated 39 approval mutants / 73 total; the refactored expiry branch has a different statement shape. No excluded mutation operators, thresholds or other source ranges were relaxed. This remains deliberately scoped mutation coverage, not repository-wide coverage or mutation proof for every new queue branch.

## Limits

This is admission-time revalidation, not continuous enforcement against changes after provider start. Approval hashes bind task values and referenced IDs, not a content snapshot of every repository file, instruction profile, agent definition or provider configuration. Distributed ownership, durable notification delivery and approval consumption exactly once across multiple server processes are not established here. Existing fallback policy has its own admission seam; this correction specifically closes the post-capacity boundary reviewed and tested above.
