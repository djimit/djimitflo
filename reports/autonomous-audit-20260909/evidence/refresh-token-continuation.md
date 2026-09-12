# Refresh-token service continuation — local executable evidence

Scope: existing `AuthService` refresh-token methods only. No refresh API, frontend session subsystem, provider request or external mutation was added. `generateToken` and `verifyToken` semantics are unchanged.

## Reproduced defects and corrections

| Defect | Executed evidence | Correction |
| --- | --- | --- |
| ISO `expires_at` compared lexically with SQLite `datetime('now')`: same-day expired/exact-boundary/offset timestamps and invalid text were accepted | Four failing expiry assertions in `refresh-token-continuation-red.log` | Compare parsed SQLite Julian times against bound current UTC time; invalid text parses to NULL and is rejected; legacy SQLite timestamp and offset formats remain accepted when future |
| Old token revoked before replacement signing/insertion; failures destroy a usable session | Injected signing exception and SQLite INSERT-abort trigger both failed rollback assertions | Immediate SQLite transaction covers validation, old-token revocation and replacement insertion; both fault paths now preserve original database state and permit retry |
| Every rotation reset `session_id`; `rotated_from` always NULL | Three-generation lineage assertion failed | Keep the original session ID; store previous token's SHA-256 hash, never the raw token |
| `expires_in=900` regardless of configured access JWT lifetime | A one-hour configuration returned 900 despite actual signed lifetime 3600 | Derive response lifetime from the freshly signed token's `exp-iat` claims |

## Validation

- `npm test --workspace=@djimitflo/server -- refresh-token-continuation.test.ts`: **8 failed / 6 passed before correction**, preserved in `refresh-token-continuation-red.log`. Tokens appearing in assertion diagnostics are disposable synthetic fixture credentials, not operator credentials.
- `npm test --workspace=@djimitflo/server -- refresh-token-continuation.test.ts refresh-token-rotation.test.ts`: **22 passed**, `refresh-token-continuation-green.log`.
- Server type-check: exit 0, `refresh-token-continuation-type-check.log`.
- Focused ESLint for service and new tests: exit 0, `refresh-token-continuation-lint.log`.

Tests execute the real SQLite schema and service. A deterministic JavaScript clock plus fixture-only SQLite `datetime('now')` clock keeps the original broken comparison reproducible independently of execution time; SQLite parsing/comparison is not replaced. Additional passing cases cover future legacy/offset timestamps, expired SQL-format and empty timestamps, hash-only storage, rolling thirty-day refresh expiry, current database role on reissue, disabled-account rejection, and existing user-wide replay revocation without revoking another user's refresh tokens.

## Explicit limits and retained semantics

- Current production-source caller search finds only internal calls in `auth-service.ts`; routes and frontend do **not** call these refresh methods. Status is **service behavior locally verified / application session-refresh chain disconnected**, not end-to-end refresh authentication.
- Refresh TTL remains rolling thirty days per issuance, not an absolute thirty-day session-family deadline.
- Reuse still revokes all refresh tokens belonging to that user, including other sessions; this preserves existing policy. Session lineage is now recorded but does not silently narrow revocation.
- Refresh-token revocation does not revoke already issued access JWTs. Current-principal authorization is a separate parent-owned change.
- Immediate SQLite write transactions serialize this database's writers; this is not evidence of a distributed session service or a real concurrent multi-process load test.
- Inactive/missing-user rotation retains existing refusal/revocation behavior. No password-change endpoint or new automatic cleanup claim is introduced.
