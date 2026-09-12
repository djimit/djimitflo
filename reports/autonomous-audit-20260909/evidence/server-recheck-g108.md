# G108 server regression recheck

The first full-server run after G107 emitted one transient `route-permissions-http.test.ts` failure and a non-Git diagnostic (`fatal: not a git repository`). The affected test passed in isolation (5/5), and an immediate complete rerun passed **2434 tests / 20 skipped** across **291 files** (2 skipped). No assertion or permission boundary was weakened. The diagnostic remains non-failing output from an existing fixture path.

Scope: local audit worktree only; no deployment, provider-quality or production-runtime claim.
