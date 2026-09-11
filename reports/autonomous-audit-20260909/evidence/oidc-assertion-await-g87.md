# G87 — awaited OIDC rejection assertion

The OIDC security test previously created a rejected promise without awaiting the Vitest assertion. The callback is now async and awaits `.rejects.toThrow`, removing the future Vitest failure window.

```text
npm run test --workspace=@djimitflo/server -- --run src/__tests__/oidc-audit.test.ts --reporter=dot
Test Files  1 passed
Tests       14 passed
npm run type-check --workspace=@djimitflo/server  PASS
npm run lint --workspace=@djimitflo/server        PASS
```
