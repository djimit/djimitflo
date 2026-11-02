# Evidence, uncertainty and coverage register

## Grades and deployment identity

**OBSERVED** means actual browser/process/source state. **VERIFIED** means a named claim corroborated or recomputed within its stated scope. **INFERRED** identifies hypotheses; **UNVERIFIED** means insufficient evidence. Historical/configuration evidence never automatically becomes current execution proof. HTTP, CI, signatures and storage cannot certify independent business outcomes.

Assessment: 24 October 2026 local. Production advanced from baseline be0b3ab to f957b552c9f02ffc5fb25c45d24431610e57f278. [Final identity](live-identity.json), 23:10:35 UTC: matching build/source, deploy-vps.sh build21:35:20Z, image2c4a818d…, running healthy,0 restarts. Exact source was read in detached `/private/tmp/djimitflo-l6-src`. Dirty local authoring HEAD9946ea4… is not deployed source. User changes remain intact; no merge/PR/deploy/clean/reset occurred.

## Retained evidence

| Artifact | Scope and limits |
|---|---|
| live-identity.json | Container/image/build identity at final read, not continuous availability |
| route-api-inventory.json | Current AST:50 declarations/49 patterns/7publicroutes, component/API call sites; not network capture |
| schema-counts.json / collect-schema.mjs | SQLite table names and selected schema/counts; regex selection does not inspect every table's contents |
| runtime-db-evidence.json / collect-evidence.mjs |22:40:02–05 UTC readonly/query_only consistent transaction;39 queries,6existingreaders,SQL/parameters/source/flags; no prompts or secrets |
| experiment-diagnostics.json / collector | Assignment/outcome exclusions, unique goal/run and crossover checks, TG paired report; mutable operational data remains mutable |
| built-reports.json / collector |22:51 UTC existing pure evolution/cost readers; different windows from earlier snapshots, not new experiments |
| offline-analysis.json / analyze-evidence.py | Independent Fisher arithmetic, skill hashes, capability/economics counts and assertions; no causal effect invented |
| skills-*.json / inspect-skill-files.py | Bounded SKILL metadata/hashes only; no package execution or script/content audit; canonical SHA39a3c44… |
| canonical-skill-validation.txt | Existing structural validator exit0,163 files/40 warnings/0 errors; functional quality unverified |
| mesh-runtime-evidence.json |22:58 UTC source hashes/image IDs/health GETs for router/registry/bus; no dispatch or event published |
| postgres-metadata.txt / postgres-columns.jsonl | PG16.15/langgraph schemas; initial row counts are estimates,−1 means unknown |
| postgres-evidence.jsonl / postgres-evidence.sql |22:50UTC13JSONrecords,REPEATABLE READ READ ONLY,default_transaction_read_only=on,ROLLBACK; aggregates/metadata, no raw memory/prompts |
| qdrant-collections.json |22:52 UTC existing client auth accepted,24collection metadata; no points/query/inference or relevance evaluation |
| screenshots01–05 | Fresh Safari captures visually inspected: config, governance, audit false-empty, health, knowledge fitness/overflow |
| ../djimitflo-ux/ | Baseline37navigationpages/32namedactions/12screenshots and source/DB/runtime evidence; older release, not recaptured current evidence |
| source-evidence-index.md | Exact-commit implementation anchors |
| SHA256SUMS / validation.json | Local pack integrity/check results, not independent attestation |

SQLite was readonly/query_only; PostgreSQL used existing container-local authorization and read-only transactions. Qdrant reused the intended client's credential without printing it. No credential creation, exposure or bypass. Ordinary reads can produce access logs/process counters; application data/configuration was not mutated. MCP fresh load was excluded because its known GET persists probe/catalog state. SEGML retrieval updates access metadata and was not invoked. Existing skill validator was inspected; its writing self-test mode was not used.

## Cross-host observations

| Host | Session observation | Limit |
|---|---|---|
| VPSagentical | DjimitFlo live Docker, router/registry/eventbus/Redis | Not full host/CI/traffic history |
| agenticservices | Hermes imagev2026.9.24; state /home/dlandman/hermes-state→/opt/data;PGpgvector16,Qdrant1.19.1,knowledge-mcp,UAMS | No Hermes Git SHA in container; mounts/process are not task readiness |
| Eve-V | Native hermes-gateway.systemd active,PID279156,WD/home/djimit/.hermes; restricted reviewer sshd active; Dockerps empty | Running artifact/model version unresolved, no test task |
| Macmini | launchd HermesgatewayPID1327 launcher/usr/bin/osascript;hostagent1328,shadow1331,Ollamaapp1508; checkout6d49922875f60af5bc31e2bfbae78a81d2fa91fc | Checkout not proven running artifact; Docker missing from PATH does not prove uninstalled |
| Workstation | Native Hermes profile active, checkout6e69a8933adda7dbbff7cf3009a259a4524477e9; OpenClaw package2026.10.6; Ollama/knowledge/atomic and DeerFlow services | Installed model/process is not inference or adapter E2E proof |
| Macbook/local | Browser session accessible; openclaw command absent default PATH | Installation/version UNKNOWN |
| djimit-web | Fleet UI live host | Direct runtime/storage not inspected |

These native facts were observed through read-only service/process/package/Git commands; unlike mesh snapshots, not every output is retained in a separate file. Treat them as OBSERVED session evidence, not reproducible full-host certification. Seven-host heartbeat is not complete fleet coverage.

## Uncertainty register

| ID | Limitation / next bounded verification |
|---|---|
| U01 |9current navigation rechecks/28 baseline only; current source all inventoried. Rerun changed/critical routes first; no all-fresh E2E claim |
| U02 | Native Safari AX/screenshots, no continuous request capture. Instrument isolated action→request→execution chains |
| U03 | Mutating actions/auth failures/tenant boundaries not exercised. Isolated fixtures/staging needed |
| U04 |694old PG pending projections: identify owner/cursors/retirement before outage or replay claim |
| U05 | Native package usage/version/scripts not joined. Instrument existing producer, no automatic activation |
| U06 | Memory/skills/swarm causal benefit insufficient. Finish frozen protocols, independent held-out replication |
| U07 | Missing cloud energy/prices/lease fields prevent total cost/ROI. Display coverage and measure existing paths |
| U08 | First verification/regression history not immutable status windows. Reconstruct only supported events |
| U09 | Notifications/NAS/object-storage/CI rollback/full adapter auth untested. No message or transaction sent |
| U10 | No complete WCAG/mobile/reconnect/fault-recovery or timed operator study. Actual overflow observed; formal tests remain |
| U11 | Every300setting/API/flag/dead-code path not individually traced. Representative consumers inspected, not exhaustive static proof |
| U12 | Qdrant relevance/embedding compatibility/contamination unmeasured. Annotated query fixture and adapter contract needed |
| U13 |22 positive settlement rechecks do not prove held-out causal gain/transfer. Keep sustained improvement UNVERIFIED |

## Acceptance status

The route inventory and broad browser baseline, current critical rechecks, safe interaction tests, source/DB/runtime correlation, core metric contracts, configuration/integration/diagnostic assessment, capability/skill/memory/evolution/economics analysis and implementation backlog/experiments/roadmap are delivered. This is a **completed bounded assessment with declared gaps**, not full production functionality certification or exhaustive ecosystem access. Lower-level metrics and inaccessible components remain unverified. No fabricated diagnosis times, inference calls, health or causal gains fill those gaps.

PhaseD produced documentation and reproducible evidence tools only. No application behavior was changed. Proposed fixes' application regression/CI testing remains future implementation work; this audit does not claim it passed. Hashes/checks prove artifact consistency within the pack, not independent scientific replication.
