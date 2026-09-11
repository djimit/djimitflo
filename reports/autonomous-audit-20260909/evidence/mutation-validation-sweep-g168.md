# G168 bounded negative mutation sweep

Scope: 20 selected local CRUD/contract POST routes, each called once with an empty JSON body against a fresh disposable runtime. Execution/deployment/provider-triggering routes were excluded.

Before repair, three routes leaked SQLite constraint failures or unclassified domain errors as HTTP 500: `/api/cognitive/episodes`, `/api/policies`, and `/api/swarms/intelligence/missions`.

After repair, the same fresh-runtime calls return deterministic validation responses:

- cognitive episodes: 400 `VALIDATION_ERROR` (`loopRunId is required`)
- policies: 400 `VALIDATION_ERROR` (`name is required`)
- swarm missions: 400 `SWARM_MISSION_TITLE_REQUIRED`

The other 17 selected routes also returned 400 validation responses. No fixture rows were created. Regression coverage is in `mutation-validation.test.ts`; the complete server suite remains green after the fixes (311 files, 2472 passed, 20 skipped).
