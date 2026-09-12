# G261 server regression

Fresh full server regression after the meta-orchestration, empty-learning-window and repository-index search-boundary repairs:

- 322 test files passed, 2 skipped
- 2,516 tests passed, 20 skipped, 0 failed
- focused route-permission regression: 2 files, 8 tests passed

The existing noisy `fatal: not a git repository` output is emitted by a known test fixture and did not produce a failed assertion.
