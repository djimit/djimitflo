# Targeted table reachability review

This is a semantic follow-up to the static graph, not a claim that every table must have a UI. No production database or external service was mutated. Source-only conclusions are labelled; the two persistence cases below have isolated execution evidence.

## Repaired: swarm planning sessions

`POST /api/swarm/sessions` → `SwarmOrchestrationService.createSession` → `swarm_sessions` INSERT previously wrote durable state, while GET list/progress read only an instance Map. A new service instance therefore returned no sessions and threw `SWARM_SESSION_NOT_FOUND` for an existing row. This is lost reachability, not missing execution: session execution already deliberately rejects with `SWARM_RUNTIME_EXECUTOR_NOT_CONFIGURED`.

The service now reads the same database for list/progress/existence, without a second state cache. Regression tests prove creation → new instance → identical list/progress, cross-instance visibility and durable deletion visibility. Execution remains blocked and does not alter planning state. Evidence: [red](evidence/swarm-session-persistence-red.log), [passing persistence and existing apex tests](evidence/swarm-session-persistence-final.log). This is tested durable planning, not autonomous swarm execution.

## Repaired: audit anchors

Writer: `AuditAnchoringService.persistAnchor` (`services/audit-anchoring.ts`). Expected readers: its `getAnchors`, `getLatestAnchor`, `getDeadLetterQueue`, consumed by `GET /api/console/overview` and `/api/console/audit`. They read instance arrays, not `audit_anchors`. An isolated fixture with one persisted confirmed anchor returns `[]` and `null` from a fresh service: [diagnostic](evidence/audit-anchor-persistence-diagnostic.json).

The service now reads durable anchors and dead letters. Status-only UPSERT preserves immutable Merkle identity; absent configuration fails explicitly. Tests use actual loopback HTTP endpoints and reopen file-backed SQLite, proving retry after rejection and manual dead-letter retry persist a single identical anchor. No production SIEM/WORM endpoint was contacted. HTTP acceptance is not remote retention/verification; pending retry timers remain process-local and do not automatically resume after restart. `evidence/persistence-final.log` includes these executable checks.

## Other write-only tables: actual role, not blanket failure

| Table | Writer and downstream chain | Assessment |
|---|---|---|
| `model_execution_outcomes` | `MultiModelIntelligence.recordOutcome` also updates `model_capabilities`; routing reloads that durable aggregate through `loadModels` | Raw history is retention-only; current routing does consume the outcome projection. Not a demonstrated learning-loss defect. |
| `repository_scans` | `RepositoryScanner` atomically writes scan identity and reads latest scan to select current findings | Now ACTIVE source reachability after G39: scan history anchors current finding IDs and prevents stale findings masquerading as current. Historical scan UI remains unproven. |
| `runtime_contract_probes` | `RuntimeCommandService` saves each probe; current callers receive freshly computed contract/cache | Durable diagnostic snapshot, not trusted restart readiness. Re-probing avoids treating stale binary availability as live proof. |
| `council_aggregations` | `SynthesisEngine` stores rankings; council computes scores from evaluations and persists synthesis/session outcome separately | Redundant retained intermediate, not missing current synthesis result. Historical aggregation reader absent. |
| `self_model_snapshots` | `SelfModelService.snapshot`; `getModel` recalibrates from `worker_leases` and `swarm_capabilities` | Snapshot retention; current model recomputation remains connected. Version counter resets; longitudinal snapshot comparison not implemented. |
| `agent_archives` | `AgentRetirementService` archives evidence before retirement | Forensic retention only; no restore/history UI found. Do not delete archive merely because it lacks a runtime reader. |
| `plugins` | `PluginRegistryService.installPlugin/discoverPlugins`; list/get read only Map and constructor rediscovers disk manifests | Source-confirmed persistence gap for programmatic installation, but install has no production caller. Disk rediscovery intentionally disables plugins. Apex enable/disable now use manage:config and explicitly return503 because no shared trusted runtime activation path exists; no router-local flag is presented as enforcement. See ROUTE_PERMISSION_REVIEW.md. |
| `segml_runtime_targets` | `SegmlRuntimeGovernanceBridge.tightenMonitoring` persists and caches targets; `getTightenedTargets` reads cache only | Source-confirmed restart-loss and disconnected enforcement: no runtime caller of that getter found. Hydration alone would not prove thresholds enforced. |
| `fleet_work_distribution` | `FleetMeshService.distributeWork` writes selected-node assignment and returns it | Selection record, not node execution; no queue consumer or transfer effect found. Keep remote execution DISCONNECTED, do not add a new worker authority. |
| `fleet_capability_sync` | `FleetMeshService.syncCapability` stores received metadata and returns it | Intake receipt only; no application of remote capability to local registry found. Promotion requires existing authority, not automatic trust of remote score. |
| `code_chunks` | Repository-index persistence/restoration | Repaired parent REPLACE cascade loss, durable search and snapshot replacement. Actual file-backed SQLite close/reopen, deleted/shrunken files and storage-failure rollback tested. Vector/hybrid remain lexical aliases; no embedding proof. |

## Unreachable schema: no operational producer/reader established

`agents_md_issues`, `council_reliability`, `explainer_feedback`, `repository_scan_artifacts`, `sub_agent_scratch`, `sub_agent_tool_outputs` remain schema/experimental scaffolding with no production SQL writer or reader in the inspected source. `worker_results` is now active worker-outcome persistence with a production writer and restart reader in `BackgroundWorkerService`. [Evidence](evidence/worker-results-reachability-g264.md)

`instruction_profiles`, `sandbox_policies`, `task_artifacts` are legacy/reserved domain schemas with foreign-key references but no operational writer/reader found. Current instructions, runtime sandbox settings and execution evidence use other existing paths; their table names do not demonstrate those controls.

`audit_logs` is legacy beside canonical `audit_events`; the similarly named HTTP route now reads `audit_events`. `openmythos_attestations` has schema only in the inspected implementation; an external producer is not demonstrated, so it remains dormant/unproven rather than assumed intentionally active.

These dispositions do not broaden authorization to delete tables, auto-enable plugins, dispatch remote work or create approval authority.
