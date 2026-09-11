# G357 verification

- `npm run build`: PASS (all workspaces, including dashboard Vite build).
- `npm run type-check`: PASS (all workspaces).
- `npm run lint`: PASS (all workspaces).
- Full workspace regression: PASS, 2,857 passed / 20 skipped / 0 failed (`workspace-regression-g356.log`).
- Full server regression: PASS, 2,566 passed / 20 skipped / 0 failed (`server-regression-g356.log`).
- Governed loop self-check: PASS, 296 passed / 1 skipped / 0 failed (`loops-self-check-g357.log`).
- Contract inventory and route-contract inventory: PASS, 585 routes / 556 direct tests / 0 critical unclassified; MCP 56/56.
- CI advisory audit and integration probes: PASS.
- Truth/live assurance: FAIL-CLOSED on external identity/provider prerequisites; no production semantic claim.

The canonical knowledge SSE subscription is locally exercised with a real HTTP listener: 200, `text/event-stream`, connected frame and disconnect cleanup.
