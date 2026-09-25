# Specification — Level-13 Expert Judge Swarm

## Functional Requirements

### Knowledge Adapters (G94)
- FR-01 System SHALL search Wikipedia via REST API for any topic
- FR-02 System SHALL search arXiv via API for academic papers
- FR-03 System SHALL query local OKF knowledge base
- FR-04 System SHALL query DjimitKB via MCP bridge
- FR-05 All adapters SHALL implement `KnowledgeSourceAdapter` interface
- FR-06 All adapters SHALL have rate limiting (max 10 req/min)
- FR-07 All adapters SHALL handle external API downtime gracefully
- FR-08 System SHALL cache adapter results with TTL (1 hour)

### Judge Service (G95)
- FR-10 System SHALL evaluate expert answers on 4 dimensions
- FR-11 Evidence quality SHALL contribute 30% to final score
- FR-12 Source reliability SHALL contribute 20% to final score
- FR-13 Logical consistency SHALL contribute 30% to final score
- FR-14 Epistemic uncertainty SHALL contribute 20% penalty
- FR-15 System SHALL detect contradictions between expert answers
- FR-16 System SHALL assign verification status to all knowledge
- FR-17 Judge verdicts SHALL be stored for audit trail

### Expert Swarm Orchestrator (G93)
- FR-20 System SHALL dispatch N expert agents in parallel
- FR-21 Each expert SHALL have a skill + knowledge source
- FR-22 Max 10 parallel sub-agents per dispatch
- FR-23 Each sub-agent SHALL have 60 second timeout
- FR-24 System SHALL collect and aggregate all expert answers
- FR-25 System SHALL pass answers to JudgeService for evaluation
- FR-26 Knowledge graph SHALL be updated if verdict score ≥ 60
- FR-27 Full provenance SHALL be stored (source → evidence → verdict)

## Non-Functional Requirements

- NFR-01 Sub-agent timeout: 60 seconds hard limit
- NFR-02 Rate limiting: 10 requests/minute per external source
- NFR-03 Cache TTL: 1 hour for adapter results
- NFR-04 Max parallel workers: 10 sub-agents
- NFR-05 Knowledge graph updates: atomic transactions
- NFR-06 All existing 946 tests remain green (zero regression)
- NFR-07 Type-check and lint clean across all workspaces

## Test Requirements

| Component | Min Tests | Coverage |
|-----------|-----------|----------|
| WikipediaAdapter | 3 | search, fetch, error |
| ArxivAdapter | 3 | search, fetch, error |
| OkfAdapter | 2 | search, fetch |
| DjimitKBAdapter | 2 | search, error |
| Adapter cache | 2 | hit, miss, expiry |
| JudgeService | 12 | scoring, contradictions, edge cases |
| Orchestrator | 12 | dispatch, parallel, timeout, aggregation |
| **Total** | **≥ 36** |