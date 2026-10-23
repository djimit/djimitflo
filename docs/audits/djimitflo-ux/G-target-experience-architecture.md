# G. Target experience architecture

The live navigation is already close to the right shape. Keep it and refine ownership rather than replatforming it.

## Target structure

| Area | Keep / consolidate | Contextual links |
|---|---|---|
| Overview | Cockpit only; retire Activity Overview after any unique content moves | Health → degraded entity; attention count → filtered Decisions |
| Operations | Decisions, Goals & Loops, Tasks, Repositories | Goal ↔ proposal ↔ run ↔ task ↔ PR |
| Agents & Capabilities | Agents plus Catalog as tabs/views of one registry | Capability → runtime, dependencies, usage, failures, value |
| Workflows | Goals & Loops with pipeline drafts as an advanced tool | Workflow → effective config → runs → logs |
| Evolution | Improvement Funnel + Evolution | Proposal → evidence/panel → goal → experiment → verification → survival |
| Data & Knowledge | Knowledge, Frontier Experts, Agent Commons | Claim/source → use in decision → measured outcome |
| Integrations | Fleet/Usage-derived integration registry | Integration → health → config → failures → dependent capabilities |
| Observability | Observability, Audit and Authority as tabs/views | Every entity opens the same ContextTrail |
| Configuration | Effective configuration catalog with task filters and raw advanced view | Config → consumers → restart/apply semantics |

## Reusable patterns

- `EvidenceBadge`: evidence tier, timestamp and source.
- `OperationalState`: common configured/connected/healthy/degraded/failed/disabled/unknown vocabulary.
- `MetricContractPopover`: numerator, denominator, window, exclusions and freshness.
- `ContextTrail`: cross-entity chronology and links.
- `SafeAction`: shows scope, reversibility and audit behavior; confirmation only for meaningful irreversible/destructive actions.
- `QueueView`: count, filters, pagination/virtualization, bulk-free default and keyboard-friendly row actions.

Reuse current page and API patterns; the exact production source already has `useResource`, a global error boundary, permission-aware navigation and consolidated hubs.
