# G107 advanced feedback limit validation

`GET /advanced/feedback/recent` now rejects NaN, zero, fractional and
over-limit query values with structured HTTP 400 before SQLite access. Valid
limits remain backed by the durable governance-feedback store.

```text
npm run test --workspace=@djimitflo/server -- advanced-routes.test.ts --run
  Test Files: 1 passed
  Tests: 1 passed
npm run type-check --workspace=@djimitflo/server   PASS
npm run lint --workspace=@djimitflo/server        PASS
```

The regression uses a real local Express/SQLite route instance. No provider,
promotion or deployment was invoked.
