# Mutation regression — G239

Command: `npm run test:mutation` from the repository root.

Result: **71/71 configured mutants killed; 0 survived; 0 uncovered; 0 errors**. Stryker initial dry run succeeded (67 tests), and the configured mutation scope completed in 19 seconds. Scope is the three configured source regions (`approval-service`, `tool-broker`, `docker-sandbox-executor`), not repository-wide mutation certification. The earlier native Node/V8 crash remains historical only; this current run completed without retry.
