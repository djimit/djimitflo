# G100 SEGML Level 3 route validation

The authenticated SEGML Level 3 scenario route previously converted any query
value with `Number()` and silently accepted `0`, negative, fractional and
`NaN` counts. Those inputs produced an empty or malformed scenario response
with HTTP 200.

The route now validates an integer count in the inclusive range 1–50 and
returns a structured `VALIDATION_ERROR` with HTTP 400 otherwise.

```text
npm run test --workspace=@djimitflo/server -- segml-l3-routes.test.ts segml-level3-finetuning.test.ts --run
  Test Files: 2 passed
  Tests: 11 passed
npm run type-check --workspace=@djimitflo/server   PASS
npm run lint --workspace=@djimitflo/server        PASS
npm run assurance:contracts (G100 regeneration)
  routes: 581 total, 256 tested, 0 critical_unclassified
  mcp_tools: 56 total, 28 tested, 0 critical_unclassified
```

The focused HTTP test exercises `0`, `-1`, `1.5`, `NaN`, `51` and a valid
`count=2` request against a real local Express/SQLite route instance. No
external provider, production deployment or promotion was performed.
