## Why

Djimitflo's services and full test suite pass, but live HTTP validation exposed
two client errors that escape as HTTP 500: an invalid task execution mode and an
unknown executor. OpenMythos works through the real HTTP API, but that success
path is not preserved as a route regression test.

## What Changes

- Prove task creation, execution, persistence, cancellation, and invalid inputs
  through the HTTP boundary.
- Prove OpenMythos eval, score, report, trend, auth, validation, and missing
  configuration through the HTTP boundary.
- Add the missing proof-run latest and loop runtime-contract route checks.
- Label filename-based test matching honestly instead of presenting it as
  integration coverage.
- Propagate a request ID and avoid stack logging for expected client errors.

## Non-Goals

- New dependencies, test frameworks, route registries, or coverage platforms.
- Broad service refactors based on file size.
- Full 351-case live model execution or skill promotion.
- Commit, push, merge, or deployment without the final human gate.

## Success Criteria

- Invalid task enums and executor names return stable 4xx error codes.
- A task completes through HTTP and persists execution evidence.
- A one-case OpenMythos HTTP evaluation persists and exposes its result.
- Proof latest and runtime contracts have positive and negative route checks.
- Self-improvement output distinguishes filename matching from integration
  coverage.
- All repository, OpenMythos, shuffled-order, and live smoke gates pass.
