# G67 — complete source identity beyond the default subprocess buffer

Reproduced blocker: `browser-session-assurance.log` records `sourceState()` aborting with `spawnSync git ENOBUFS` on the audit worktree's `git diff --binary HEAD`. The subprocess default was approximately 1 MiB, smaller than the current patch. This was an assurance infrastructure failure, not evidence that the product passed or failed its functional gates.

Correction is limited to `scripts/assurance-truth.mjs` and its existing focused test. Source subprocesses now use a bounded **64 MiB** buffer, matching the existing assurance gate runner. There is no diff truncation, exclusion or weakened hash. Required Git status, untracked inventory and HEAD failures now throw rather than substituting an empty/clean identity; optional environment metadata retains its prior nullable behavior. Exceeding the ceiling still fails closed.

Executed verification:

- `node scripts/assurance-truth.test.mjs` — exit 0 (`assurance-source-buffer-green.log`). A disposable Git repository produces a real diff larger than 1 MiB. Its source-state hash equals the independently calculated SHA-256 of the **entire** diff and differs from hashing only the first MiB. Changing file content after the first MiB changes the final identity. Missing repository identity throws. Existing redaction assertions remain green.
- Direct `sourceState()` against the current audit worktree — exit 0 (`assurance-source-current-worktree-green.log`), retaining `dirty: true` and emitting only commit/hash metadata, not diff contents.
- Focused `git diff --check` — exit 0.

The test's temporary Git repository was removed in `finally`; only generated disposable fixture data was deleted. No tracked source, existing evidence or user repository was removed. Parent-owned aggregate assurance rerun is separate evidence; this check alone does not certify its other gates. The captured worktree hash is a historical invocation snapshot, not a claim that concurrently edited work remained unchanged afterward.
