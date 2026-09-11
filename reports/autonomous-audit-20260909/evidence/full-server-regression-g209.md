# G209 full server regression

Command: `npm run test --workspace=@djimitflo/server -- --run`.

Result: **311 test files passed, 2 skipped; 2489 tests passed, 20 skipped; 0 failed**. The run includes the catalog compiler HTTP regression and the OIDC signature-test hardening. A known isolated-fixture diagnostic (`fatal: not a git repository`) is emitted by an existing negative probe and does not fail the suite.
