# G83 ToolBroker principal binding — required at validation

The capability-token validation boundary now requires the presenting principal identifier. A token cannot be validated without the principal that presents it; the broker compares that identifier with the durable token owner before accepting the token.

## Evidence

- `packages/server/src/services/tool-broker.ts` SHA-256: `636ad5411278f36cf2755d407159a04b2e2a3d45bd7d97bac8d02ed2fb371c57`
- `packages/server/src/__tests__/security-invariants.test.ts` SHA-256: `bb1db3e43df087b4272d6b1708d59a5336faba57bc544c78f93d1807377df9cf`
- `npm run test --workspace=@djimitflo/server -- --run src/__tests__/security-invariants.test.ts` → **19 passed**.
- `npm run test --workspace=@djimitflo/server -- --reporter=dot` → **286 files passed / 2 skipped; 2429 tests passed / 20 skipped**.
- `npm test` → **2716 tests passed / 20 skipped** across all workspaces; the prior concurrent `proof-run`/swarm test 401 was reproduced and is now green after removing process-wide `chdir()` from the proof-run fixture.
- `npm run type-check --workspace=@djimitflo/server` → pass.
- `npm run lint --workspace=@djimitflo/server` → pass.
- `git diff --check` → pass.

The regression covers same-principal validation, cross-principal rejection, wrong tool/task rejection, restart reload, revocation and corrupt/expired token cleanup. No production provider or external system was changed.

## Boundary retained

This closes the accidental bearer-token API path only. Native provider CLI tools still do not expose a server-owned pre-effect callback, so universal ToolBroker mediation remains **DISCONNECTED** (G10). Streamed tool events remain observability, not proof of prevention. No claim is made for provider-internal tool enforcement, deployment, or live authenticated UI behavior.
