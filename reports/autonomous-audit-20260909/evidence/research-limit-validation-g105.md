# G105 research trust-threshold validation

`GET /research/sources/trusted` now validates `min_trust` at the HTTP boundary.
NaN and values outside the inclusive 0–1 range return structured HTTP 400;
valid thresholds continue to query the durable research source store.

```text
npm run test --workspace=@djimitflo/server -- research-routes.test.ts citation-research.test.ts --run
  Test Files: 2 passed
  Tests: 9 passed
npm run type-check --workspace=@djimitflo/server   PASS
npm run lint --workspace=@djimitflo/server        PASS
```

The route regression exercises `NaN`, `-0.1`, `1.1` and valid `0.8` against a
real local Express/SQLite instance. External research providers and deployment
were not invoked.
