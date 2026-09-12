# G265 route registration

The runtime route inventory was regenerated through the real `createRoutes` aggregator and anonymous HTTP probes. `reconstruct-capabilities.mjs --check-route-registration` passed with 619 registered routes and 610 anonymous auth probes. Source/runtime comparison is empty; semantic execution remains explicitly `NOT_EXECUTED` for the broad inventory.

The new un-JWT callback mount is exact and ordered before generic `/swarm-v2`: `/api/swarm-v2/social-runtime/:agentId/heartbeat`, `/messages`, and `/messages/:messageId/respond`. Its own signed-token and runtime-governance checks are covered by the focused end-to-end test.
