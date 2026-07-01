# Design

## Decision

Reuse the existing work item and loop runtime model. The spine is a thin intake and evidence-linking layer over the current system, not a new orchestration engine.

The canonical runtime chain is:

1. Normalize external event into `work_items`.
2. Plan selected work item into existing goal and loop records.
3. Prepare maker/checker `worker_leases`.
4. Start workers only through the existing worker pool scheduler.
5. Run checker and deterministic gates.
6. Close learning loop into eval, reflection and optional memory or repair candidates.
7. Render the linked chain in Mission Control.

## Integration Inbox

`work_items` remains canonical. Each integration-origin item stores source identity in normal columns and integration details in `metadata.integration`.

Supported v1 sources:

- `github_issue`
- `telegram_command`
- `mcp_drift`
- `okf_drift`
- `dashboard_action`

Imports are idempotent by `source` and `source_ref`. Dry-run returns the normalized work item shape and blocked reasons without writes.

## Capability Gate

Connector influence is allowed only through existing capability and MCP permission records.

A connector can propose or route work when:

- its capability is validated and live-route-allowed
- the risk ceiling covers the work item
- required evidence is present
- MCP permission metadata allows the connector action

Unvalidated connectors may create candidate work or blocked reasons, but cannot start live execution.

## Run Flow

The implementation should add the smallest service/API surface that composes existing services:

- import/preview external event
- plan and prepare selected work item
- report integration spine state for Mission Control

Worker start, checker execution and learning closure should call existing worker pool, loop and evolution services rather than duplicating execution logic.

## Dashboard

Mission Control shows OS-level chain truth:

- source event and normalized work item
- goal, loop run and lease ids
- connector/capability gate status
- maker/checker/eval status
- reflection and memory candidates
- next safe action

Fleet Cockpit remains the runtime pool and queue truth surface.
