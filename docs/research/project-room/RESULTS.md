# PR-ABC-001: results

**Status: NOT_RUN.** No task-arm has been executed with a model. Every cell below is NOT_RUN, not a zero and not a failure.

| Set | Arm A | Arm B | Arm C |
| --- | --- | --- | --- |
| development (20) | NOT_RUN | NOT_RUN | NOT_RUN |
| holdout (10) | NOT_RUN | NOT_RUN | NOT_RUN |

What exists: the frozen manifest and protocol, the runner, and its local verification with scripted adapters on a fixture
repository (`packages/server/src/__tests__/project-room-abc.test.ts`): isolation of the workspace from the solution commit,
the hidden check, the arm schedule and the paired analysis. That verifies the pipeline; it says nothing about the effect.

Not verified: a live run on any runtime; that a maker worktree made from a parent-only repository has the dependencies the
hidden check needs (step 1 of the protocol exists to find that out).

## Deviations

None yet.
