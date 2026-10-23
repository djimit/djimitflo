# A. Full platform inventory

## Route and capability map

| Route | Navigation | Purpose / primary data | Browser coverage | Status |
|---|---|---|---|---|
| `/` | Operate / Cockpit | Health, evolutionary funnel, operator queue, efficiency, schedulers, services, stalls, species and workers | Full live | PARTIALLY_WORKING: valuable summary, semantic gaps remain |
| `/decisions` | Operate | Approvals, loop PR settlement, Dependabot lane, requeue, pre-screen, attribution and relevance labels, Telegram allowlist | Full live, no mutations | WORKING read-only; excessive page length |
| `/goals-loops` | Operate | Goal creation, loop launch and run history | Live shell/data load | NOT_TESTABLE mutations |
| `/tasks`, `/tasks/:taskId`, `/tasks/:taskId/review` | Operate / contextual | Task list, execution detail and review | List live; detail source-covered | PARTIALLY_WORKING |
| `/repositories`, `/repositories/:id` | Operate | Repository inventory, scans and detail | List live; detail source-covered | PARTIALLY_WORKING |
| `/improvement-funnel` | Improve | Proposal-to-goal throughput, yield, hygiene, calibration | Full live + DB/source | MISLEADING metrics; see D |
| `/evolution` | Improve | Verified, merged, settled, survival and value scorecard | Live + cockpit corroboration | PARTIALLY_WORKING; capability gain/reproduction unmeasured |
| `/observability` | Improve | Risk assessments, policy decisions, recent errors, SSE feed | Full live | PARTIALLY_WORKING; not an entity trace |
| `/usage` | Improve | Provider/subscription use, failures and unmapped activity | Full live | WORKING read-only; several stale failures |
| `/knowledge` | Knowledge | Sources, relevance, use and fitness | Live/source | PARTIALLY_WORKING |
| `/frontier-experts`, `/frontier-experts/:expertId` | Knowledge | Expert identities, claims, evidence and lifecycle | Live/source | PARTIALLY_WORKING; scheduler disabled |
| `/agent-commons` | Knowledge | Agent social/review activity and subscriptions | Live/source | PARTIALLY_WORKING; core review flag disabled |
| `/fleet` | Fleet | Hosts, components, runtime health and bounded commands | Full live | WORKING read-only; commands NOT_TESTABLE |
| `/agents`, `/agents/:agentId` | Fleet | Agent inventory, runtime state and detail | Live/source | PARTIALLY_WORKING |
| `/policies` | Govern | Four policy rules and enabled state | Full live | MISLEADING risk: controls look directly toggleable; effect not tested |
| `/governance` | Govern | Governance scorecard plus assurance | Full live/source | PARTIALLY_WORKING; eval action disabled in observed state |
| `/mcp-permissions` | Govern | 10 servers and 148 tool decisions | Full live | WORKING read-only; Add server NOT_TESTABLE |
| `/audit` | Govern | Audit events and log tab | Full live | WORKING read-only; weak cross-entity drill-down |
| `/authority` | Govern | Authority events and decision filter | Full live | WORKING where separately provisioned |
| `/configuration` | Govern | Effective environment grouped by prefix | Full live | PARTIALLY_WORKING; provenance/actionability weak |
| `/dashboard` | Lab | Legacy mission/activity overview and spec progress | Live | PARTIALLY_WORKING; overlaps Cockpit |
| `/swarm-resources` | Lab | Scheduler, mutation gate, assurance, work and memory queues | Live | PARTIALLY_WORKING; several empty states |
| `/swarm` | Lab | 32-agent overview | Full live | PARTIALLY_WORKING; many agents show `No model` |
| `/fleet-cockpit` | Lab | Detailed fleet/work pipeline | Opened; load not settled during capture | NOT_TESTABLE |
| `/swarm-mission-control`, `/swarm-mission-control/proof-runs/:id` | Lab | Proof runs, capacity and knowledge runtime | Live/source | NOT_TESTABLE mutations |
| `/explainers` | Lab | Repository explainer fleet | Opened/source | PARTIALLY_WORKING |
| `/pipeline-builder` | Lab | Local visual pipeline drafts/export | Live | WORKING locally; persistence limited by design |
| `/catalog` | Lab | Agent catalog | Opened/source | PARTIALLY_WORKING |
| `/interaction-board` | Lab | Correlated interactions and handoffs | Full live | WORKING empty state; zero visible interactions |
| `/self-driving` | Lab | Autonomous operations summary | Opened/source | NOT_TESTABLE |
| `/cognitive` | Lab | Episodes, strategies and meta-learning | Full live | WORKING read-only |
| `/consensus-debates` | Lab | Debate runs and outputs | Full live | PARTIALLY_WORKING: many visible failed runs |
| `/agi-reasoning` | Lab | Goal reasoning | Full live | NOT_TESTABLE mutation |
| `/predictive-analytics` | Lab | Prediction runs | Full live | NOT_TESTABLE mutation |
| `/self-healing` | Lab | Health checks | Full live | NOT_TESTABLE mutation |
| `/economy` | Lab | Budget allocation and per-capability efficiency | Full live | PARTIALLY_WORKING; allocation NOT_TESTABLE |
| `/federation` | Lab | Federation peer management | Full live + Retry | BROKEN: module import fails persistently |
| `/login` | outside nav | Authentication | Session already authenticated | NOT_TESTABLE |
| `*` | outside nav | Not-found | Source only | SOURCE PROVEN |

Legacy aliases `/approvals`, `/compliance`, `/audit/logs` and `/cockpit` redirect to consolidated destinations. This is good subtraction. No `/workstation-urls` route exists in production.

## Capability and integration inventory

Confirmed data domains include tasks, approvals, goals, loop runs, execution events/evidence, agents, skills, MCP servers/tools, policies, repositories/scans, swarm missions/tasks/proofs, cognitive episodes, knowledge claims/pages/gaps, expert identities/claims/evidence, model calls/routing/outcomes, experiments and gym holdouts, authority/audit events, fleet hosts/commands, federation peers, Telegram identities, Qdrant-backed knowledge, event outbox and GitHub PR settlement.

The production database has more than 180 domain tables. This breadth is not matched by a single entity-centric investigation model; capability exists, but operators must know which page owns which fragment.

## Inaccessible or unproven areas

- Detail-route samples were not exhaustively traversed for every task, repository, agent, expert or proof run.
- Mobile, touch and multiple viewport sizes were not available through the native-browser surface.
- Network request bodies and browser performance traces were unavailable because the in-app browser/CDP surface was absent.
- External systems were assessed only through DjimitFlo health/config/activity evidence, not by logging into each provider.
- Production writes were deliberately not performed.
