# Full server regression — G237

Command: `npm test` from `packages/server` after the AGI consensus route tests.

Result: **320 test files passed, 2 skipped; 2,507 tests passed, 20 skipped, 0 failures**. The suite still emits the known disposable-fixture `fatal: not a git repository` diagnostic without a failed assertion. One earlier run reproduced an intermittent anonymous 200 on `POST /gym/governance/:skillId/run`; this green rerun does not erase that UNKNOWN observation.
