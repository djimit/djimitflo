# G265 social-runtime execution evidence

The remote `origin/main` social-learning implementation was selectively integrated into the audit checkout while preserving local permission and route-order hardening.

- `POST /api/swarm-v2/social-runtime/:agentId/heartbeat` accepts only a scoped `X-Agent-Social-Token`, rejects missing/foreign tokens, rejects malformed runtime input, and does not reactivate paused/error/offline/pending-approval agents.
- `GET /api/swarm-v2/social-runtime/:agentId/messages` leases only `social.question`/`social.response` messages, excludes legacy messages without a typed thread, redacts secrets and returns a fencing token.
- `POST /api/swarm-v2/social-runtime/:agentId/messages/:messageId/respond` requires the lease token, persists an evidence-linked response, is idempotent, and records later peer learning as `reflection_candidates` with `empirical_status=UNDETERMINED` and `promotion_allowed=false`.
- `POST /api/swarm-v2/socialize` starts at most one bounded exchange per cooldown and requires `write:swarm_action` through the authenticated orchestration surface.
- `ContinuousLearningLoop.runCycle()` invokes the bounded socialize operation and records `socialExchangesStarted`; `AgentInteractionLedgerService` exposes social actions, runtime/model and isolated effect scope.

Executable proof: `packages/server/src/__tests__/agent-social-runtime.test.ts` (2 tests passed) and `swarm-orchestration-routes.test.ts` (3 tests passed, including start/cooldown). Poller parser proof: `python3 scripts/agent-social-poller.py --self-test` (`PASS`). No external runtime credentials or production mutation were used.
