# G84 proof-run repository identity — concurrent test isolation

The proof-run fixture previously changed process-wide `cwd` to simulate a temporary Git repository. Under the workspace Vitest run, another server test could observe that transient non-Git directory and return 401/500-adjacent failures with `fatal: not a git repository`. The runtime seam now accepts `PROOF_RUN_REPOSITORY_PATH` for the repository identity used when inserting a proof loop run; the test fixture uses that explicit path and never changes process cwd.

## Executed checks

- `packages/server/src/services/proof-run-service.ts` SHA-256: `6ed33137798dee88bb20dab96f149da1090b503c53c639f76702e4d062d086ff`
- `packages/server/src/__tests__/proof-run-service.test.ts` SHA-256: `ef1d4947ef2284a623421439c7d39775d085d66610fac418986e17bb9cdd369b`
- `npm run test --workspace=@djimitflo/server -- --run src/__tests__/proof-run-service.test.ts src/__tests__/swarm-intelligence-service.test.ts --reporter=dot` → **10 passed / 2 skipped**.
- `npm test` → **2716 passed / 20 skipped** across all workspaces; server **286 files passed / 2 skipped, 2429 passed / 20 skipped**.
- `npm run type-check --workspace=@djimitflo/server` → pass.
- `npm run lint --workspace=@djimitflo/server` → pass.
- `git diff --check` → pass.
- `npm run test:mutation` → **71 configured mutants killed**, no survivors, uncovered mutants or errors; exit 0 (Stryker reports 100% against its configured scope).

The negative-control proof-run test still sets the explicit repository path to a non-Git directory and receives the expected `503 PROOF_RUN_RUNTIME_FAILED`; no process-wide directory mutation remains. This is test/runtime identity isolation, not provider execution or deployment proof.
