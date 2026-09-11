# G103 OpenMythos limit validation

OpenMythos attestation, run and trend list routes previously passed arbitrary
`Number(query.limit)` values to their services. `NaN` could reach SQLite
`LIMIT`, while fractional and out-of-range values had inconsistent behavior.

The shared route-local parser now requires a positive integer and enforces
bounded limits: attestations 1–200, runs/trends 1–100. Invalid input returns a
structured `VALIDATION_ERROR` with HTTP 400.

```text
npm run test --workspace=@djimitflo/server -- critical-http-contracts.test.ts --run
  Test Files: 1 passed
  Tests: 7 passed
npm run type-check --workspace=@djimitflo/server   PASS
npm run lint --workspace=@djimitflo/server        PASS
npm run route-registration inventory recheck       7 tests passed
contract inventory refresh                         581 routes / 256 tested
```

The HTTP regression covers `limit=0`, `limit=NaN` and `limit=1.5` against the
actual local OpenMythos route stack. No evaluation provider, external corpus,
promotion or deployment was invoked.
