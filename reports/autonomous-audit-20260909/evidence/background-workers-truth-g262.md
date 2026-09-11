# G262 background-worker truth boundary

The four scaffolded workers `test-gap-detector`, `governance-recert`, `worktree-cleanup` and `evidence-compaction` previously returned success-like strings without performing their advertised work.

They are now disabled by default and manual runs return `WORKER_UNAVAILABLE` with the missing authority/configuration reason. The health, memory-archival, metrics and orphan-lease workers remain enabled where their database effects are executable.

The regression asserts all four disabled workers return `failed` rather than false `completed` status. No provider, repository or evidence data is mutated by these unavailable paths.
