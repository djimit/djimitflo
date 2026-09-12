# G77 ToolBroker principal-boundary continuation

The capability-token validation seam now accepts an optional principal identifier and rejects a token presented by a different principal. The durable token already binds tool and task; this closes the remaining principal-replay gap without introducing a second authority.

## Executed checks

- `npm test --workspace=@djimitflo/server -- --run src/__tests__/security-invariants.test.ts` → **19 passed**.
- Full server regression after the patch → **2420 passed / 20 skipped**, 283 files (2 skipped files).
- `npm run type-check --workspace=@djimitflo/server` → pass.
- `npm run lint --workspace=@djimitflo/server` → pass.
- `npm run build --workspace=@djimitflo/server` → pass.
- `npm run test:mutation` → **75/75 killed**, 0 survived, 0 uncovered, 0 errors in the configured governance/security scope.
- Route and integration assurance rerun → 577 routes / 247 tested / 0 critical unclassified; 56 MCP tools / 28 tested; integration probes pass; CI advisory audit has no unaccepted high/critical production advisories.
- `npm run assurance:truth` remains **BLOCKED** at the pre-existing `openmythos_evidence` and `live_identity` mandatory gates; no local broker change alters that external evidence boundary.

## Boundary retained

This proves the broker token invariant only. Native provider CLIs still execute tools outside the server process and do not expose a pre-effect callback; their streamed tool events are observability, not universal ToolBroker enforcement. G10 therefore remains `DISCONNECTED` for that external boundary and is not relabelled as solved.
