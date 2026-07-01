# Specification — Level-14 Scalable Expert Swarm

## Functional Requirements

### G97: Skill-Driven Workers
- FR-01 Elke expert sub-agent SHALL een skill procedure ontvangen
- FR-02 Skill procedure SHALL worden geïnjecteerd als context in de prompt
- FR-03 ExpertAnswer SHALL skill metadata bevatten

### G98: Worker Pool
- FR-10 System SHALL N workers parallel draaien (configurable)
- FR-11 Max 10 parallelle workers per dispatch
- FR-12 Elke worker SHALL 60s timeout hebben
- FR-13 Failed workers SHALL automatisch worden geretried (max 2x)
- FR-14 System SHALL worker health monitoren (active/queued/completed/failed)

### G99: Judge Human-in-the-Loop
- FR-20 Score ≥ 80 + geen contradictions → auto-approve
- FR-21 Score 60-79 → human review required
- FR-22 Score < 60 → rejected met reasoning
- FR-23 Review requests SHALL in operator intervention queue verschijnen

### G100: OKF Knowledge Graph
- FR-30 Verified knowledge SHALL automatisch als OKF concept worden opgeslagen
- FR-31 OKF concepten SHALL frontmatter bevatten (confidence, verification, sources)
- FR-32 Bestaande concepten SHALL worden geüpdatet bij nieuw bewijs
- FR-33 Bronnen SHALL worden gelinkt aan concepten

### G101: Skill Evolution
- FR-40 Post-run analyse SHALL skill improvement proposals genereren
- FR-41 Herhaalde low-confidence results SHALL skill updates triggeren
- FR-42 Candidate skills SHULL automatisch promoten naar validated bij bewijs

## Non-Functional Requirements

- NFR-01 Worker pool concurrency: configurable, default CPU cores × 2
- NFR-02 Worker timeout: 60 seconds hard limit
- NFR-03 Retry policy: max 2 retries per failed worker
- NFR-04 Rate limiting: 10 req/min per external source
- NFR-05 Cache TTL: 1 hour for adapter results
- NFR-06 All existing 990 tests remain green
- NFR-07 Type-check and lint clean

## Test Requirements

| Component | Min Tests |
|-----------|-----------|
| G97 Skill Workers | 4 |
| G98 Worker Pool | 10 |
| G99 Judge Human-Loop | 6 |
| G100 OKF Updater | 10 |
| G101 Skill Evolution | 8 |
| **Total** | **≥ 38** |