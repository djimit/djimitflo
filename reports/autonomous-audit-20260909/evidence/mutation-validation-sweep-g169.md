# G169 bounded negative mutation sweep

Scope: the same 20 selected local CRUD/contract POST routes as G168, each called once with an empty JSON body against a fresh built runtime on `127.0.0.1:3199` with a disposable SQLite database and temporary bootstrap admin. No provider, deployment or external system was used.

The three remaining 500 leaks from G168 were repaired at their route trust boundaries:

- `/api/risk/task`: missing task shape now returns 400 `VALIDATION_ERROR` before `CommandRiskClassifier.assessTask`.
- `/api/swarms/intelligence/claims`: missing claim, type, subject or origin now returns 400 `VALIDATION_ERROR` before the legacy insert path.
- `/api/apex/llm/route`: missing task type/prompt now returns 400 `VALIDATION_ERROR` before provider-health network calls.

Post-fix replay results: 15 routes returned typed 400 validation errors, 2 returned intentional typed 404s for missing fixtures, and 2 retained intentional local/default 200 behavior (`risk/command` fallback classification and organization switch). The twentieth route (`tasks/:id/cancel`) returned typed 404 for its missing task fixture. No 500 responses and no fixture rows were created. Runtime logs corroborate the response codes and error codes.

Regression coverage remains in `mutation-validation.test.ts`; the complete server suite is green at 311 files, 2472 passed and 20 skipped (2492 tests). The complete workspace run also passes: agent-catalog 26, dashboard 151, MCP 39, ransomware 40, server 2472, shared 3 and Telegram 30 (2761 passed, 20 skipped). This is bounded negative-input evidence, not certification of all mutation semantics or external provider quality.
