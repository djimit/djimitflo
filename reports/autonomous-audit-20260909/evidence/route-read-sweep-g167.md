# G167 corrected authenticated GET route sweep

Scope: all 308 unique registered GET routes from `contract-inventory-runtime-g166.json`, replayed against a fresh local built runtime with a bootstrap admin, bounded 3-second request timeouts and two rate-limit windows. Paths were substituted without removing the `/api` mount. No mutating request was issued.

Observed counts: **228× 200**, **65× 404**, **7× 400**, **4× 503**, **2× timeout**, **2× 500**.

The four 503 responses are intentional fail-closed authority-ledger/degraded-health states. The two timeouts are long-lived SSE endpoints (`/api/knowledge/subscribe/:capabilityId` and `/api/observability/stream`) and are not ordinary request/response failures. The two genuine 500s were both missing swarm-session progress resources; both are now mapped to typed 404 responses by the shared orchestration route and covered by `swarm-orchestration-routes.test.ts`.

Focused replay after the repair: `/api/swarm/sessions/missing-session/progress` and `/api/swarm-v2/sessions/missing-session/progress` both return 404 `SWARM_SESSION_NOT_FOUND` on a fresh runtime.

This sweep provides broad read-path evidence, not certification of mutation semantics, provider quality, or external deployment identity.
