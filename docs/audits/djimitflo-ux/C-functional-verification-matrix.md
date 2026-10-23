# C. Functional verification matrix

Verdicts are based on live behavior; SOURCE PROVEN alone never upgrades a function to WORKING.

| Function | Expected | Actual evidence | Verdict |
|---|---|---|---|
| Authentication/session restore | Protected UI opens for valid session | Authenticated admin shell and data loaded | WORKING |
| Route navigation | Each nav target opens its page | All top-level and Lab URLs opened | PARTIALLY_WORKING: lazy routes sometimes remain loading; Federation fails |
| Cockpit refresh | Re-query current status | Button present; initial age updated | NOT_TESTABLE: avoided unnecessary request churn during evidence capture |
| Decisions approval filters | Switch Pending/Approved/Denied/All | Controls and pending empty state rendered | PARTIALLY_WORKING: filter mutation not exercised |
| Decisions queue loading | Populate independent queues | PR, dependency, requeue, label and audit queues rendered | WORKING read-only |
| Requeue validation | Require reason and create linked attempt | Required reason fields and explanatory contract visible | NOT_TESTABLE: production mutation |
| Pre-screen/attribution labels | Persist operator ground truth | Toggle groups rendered with current values | NOT_TESTABLE: production mutation |
| Repository/task/agent detail navigation | Open entity context | Routes and source exist; parent inventories load | PARTIALLY_WORKING |
| Improvement metrics | Explain funnel consistently | Values load, but denominators/cohort definitions conflict | MISLEADING |
| Observability feed | Show current event/error data | Risk, policy, errors and SSE sections rendered | WORKING read-only |
| MCP inventory/filter | Show servers/tools and narrow list | 10 servers, 148 tools and filters rendered | PARTIALLY_WORKING |
| Fleet host status | Show hosts/components/runtime health | Host/component tables rendered | WORKING read-only |
| Fleet commands | Request bounded diagnostic command | ping/uptime/disk/failed-services/top controls rendered | NOT_TESTABLE: external execution |
| Configuration secrets | Avoid exposing credentials | UI/source redaction contract; terminal audit reported names only | SOURCE PROVEN / live values not copied |
| Policy enablement | Toggle and enforce rule | Four enabled rules rendered | NOT_TESTABLE: mutation plus downstream enforcement required |
| Audit/authority filters | Narrow recorded evidence | Routes and controls rendered | PARTIALLY_WORKING |
| Pipeline local export/save | Manage draft without server mutation | Clear/Export/Save-local controls rendered | NOT_TESTABLE |
| Consensus history | Show debate outcomes | Completed and many failed runs rendered | WORKING read-only, capability DEGRADED |
| Federation route | Load peer UI | Persistent module-import failure after Retry | BROKEN |
| Global lazy-load recovery | Reload after deploy | Retry reloads but returns same error | BROKEN |
| Integration service probe | Distinguish reachability and health | `up` for several HTTP 200s; TypeSafe `reachable (404)` | MISLEADING for business health |
| Health endpoint/container | Report live build and process health | Container running, Docker health healthy, restart count 0; deploy verdict OK | WORKING at process level only |

## Unverified mutation chain

No production mutation was authorized. Therefore no create/approve/deny/requeue/label/configure/run/allocate flow is claimed end-to-end. Acceptance tests for those actions must use an isolated database and assert UI action → API → domain effect → persistence → audit record → refreshed UI.
