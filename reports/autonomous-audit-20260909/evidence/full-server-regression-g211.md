# G211 full server regression

Command: `npm run test --workspace=@djimitflo/server -- --run`.

Result: **312 test files passed, 2 skipped; 2491 tests passed, 20 skipped; 0 failed**. The run includes agent-catalog root-resolution tests and deterministic OIDC tamper coverage. The known isolated-fixture `fatal: not a git repository` diagnostic remains non-failing.
