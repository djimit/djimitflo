## Approach

Follow existing workspace, service, route, lifecycle, and test conventions. Prefer
vertical integration through current entrypoints over new registries or wrappers.

### Runtime boundaries

- `api`: core API, auth, WebSocket, execution, and memory.
- `operator`: API plus PromptIntel, retention, cognitive closure, and configured
  Telegram gateways.
- `autonomous`: operator plus loops, negotiation, capability acquisition,
  meta-evolution, expert swarm, and governed self-improvement.

### Capability disposition

Each apparently unreachable service is classified using runtime callers, routes,
tests, OpenSpec claims, and OpenMythos categories:

- `integrate`: unique behavior with an existing consumer.
- `merge`: behavior already covered by a canonical reachable service.
- `on-demand`: constructed by its route or job only when used.
- `retire`: no unique behavior or executable consumer.

No deletion is based on filename or grep count alone.

### OpenMythos

OpenMythos validates capability truth and agent behavior. Small code fixes run
focused tests; full corpus or judged evaluation runs only when behavior changes.

### Mutation boundary

All work is prepared in an isolated worktree. Commit, push, merge, deployment,
and destructive capability retirement require final human approval.
