# Design — Level-13 Expert Judge Swarm

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Expert Swarm Orchestrator (G93)                        │
│                                                                         │
│  dispatch(topic, domains)                                               │
│       │                                                                 │
│       ├──→ NestedSpawnService.requestSpawn(expert-1, skill+A1)         │
│       ├──→ NestedSpawnService.requestSpawn(expert-2, skill+A2)         │
│       └──→ NestedSpawnService.requestSpawn(expert-3, skill+A3)         │
│       │                                                                 │
│       ├──→ collect answers                                              │
│       │                                                                 │
│       └──→ JudgeService.evaluate(answers) ──→ Verdict                   │
│                  │                                                      │
│                  ├── EvidenceService (30%)                              │
│                  ├── Source reliability (20%)                           │
│                  ├── DAGConsensusService (30%)                          │
│                  └── EpistemicUncertaintyService (20%)                  │
│                                                                         │
│       └──→ KnowledgeRuntimeService.update(verdict)                      │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                    Knowledge Adapters (G94)                              │
│                                                                         │
│  WikipediaAdapter ──→ Wikipedia REST API                                │
│  ArxivAdapter     ──→ arXiv API                                         │
│  OkfAdapter       ──→ OKF knowledge base (bestaand)                     │
│  DjimitKBAdapter  ──→ MCP bridge (bestaand)                             │
└─────────────────────────────────────────────────────────────────────────┘
```

## G93: Expert Swarm Orchestrator

### File: `packages/server/src/services/expert-swarm-orchestrator.ts` (~200 LOC)

```typescript
export class ExpertSwarmOrchestrator {
  constructor(
    private db: Database,
    private nestedSpawn: NestedSpawnService,
    private skills: SkillService,
    private judge: JudgeService,
    private knowledge: KnowledgeRuntimeService,
  ) {}

  async dispatch(input: ExpertSwarmInput): Promise<ExpertSwarmResult>;
  getActiveSwarms(): SwarmStatus[];
  getSwarmHistory(limit: number): ExpertSwarmResult[];
}
```

### Algorithm
```
function dispatch(input):
  1. Validate input (domains non-empty, maxParallel ≤ 10)
  2. Create swarm record in DB
  3. For each domain (parallel, max maxParallel):
     a. Acquire skill via SkillService.acquire(topic, domain)
     b. Select best adapter for domain
     c. Create sub-agent via NestedSpawnService.requestSpawn({
          role: 'expert',
          prompt: buildExpertPrompt(topic, domain, skill),
          capability_ids: [domain],
          depth_budget: 0,  # no nested spawning for experts
        })
  4. Wait for all sub-agents (timeout: 60s per agent)
  5. Collect answers from completed agents
  6. verdict = JudgeService.evaluate(answers)
  7. If verdict.score ≥ 60:
       KnowledgeRuntimeService.update(verdict)
  8. Store result in swarm_history
  9. Return ExpertSwarmResult
```

### Scaling Characteristics

| Workers | Parallel | Total Time | API Calls |
|---------|----------|------------|-----------|
| 1 domain | 1 | ~15s | 1-2 |
| 3 domains | 3 | ~15s | 3-6 |
| 5 domains | 5 | ~18s | 5-10 |
| 10 domains | 10 | ~25s | 10-20 |

Elke sub-agent is onafhankelijk — geen shared state behalve de database.

## G94: Knowledge Source Adapters

### File: `packages/server/src/services/knowledge-adapters/` (directory, ~300 LOC total)

### WikipediaAdapter (~80 LOC)
- API: `https://en.wikipedia.org/api/rest_v1/page/summary/{title}`
- Auth: none
- Rate limit: 10 req/min
- Returns: title, extract, thumbnail, page URL

### ArxivAdapter (~100 LOC)
- API: `http://export.arxiv.org/api/query?search_query={query}&max_results=5`
- Auth: none
- Rate limit: 10 req/min
- Returns: title, abstract, authors, URL, categories

### OkfAdapter (~60 LOC)
- Source: lokale OKF knowledge base (hergebruukt KnowledgeRuntimeService)
- Auth: none
- Rate limit: N/A (lokaal)
- Returns: concept content, metadata, relations

### DjimitKBAdapter (~60 LOC)
- Source: DjimitKB via MCP bridge (hergebruukt FederationService)
- Auth: MCP token
- Rate limit: 10 req/min
- Returns: knowledge chunks, source metadata

## G95: Judge Verdict Service

### File: `packages/server/src/services/judge-service.ts` (~150 LOC)

```typescript
export class JudgeService {
  constructor(
    private db: Database,
    private evidence: EvidenceService,
    private consensus: DAGConsensusService,
    private uncertainty: EpistemicUncertaintyService,
  ) {}

  evaluate(answers: ExpertAnswer[]): JudgeVerdict;
  getVerdictHistory(limit: number): JudgeVerdict[];
}
```

### Scoring Algorithm
```
function evaluate(answers):
  if answers.empty: return { score: 0, confidence: 0, ... }

  evidenceScore = answers.map(a => evidenceQuality(a)).average() * 0.3
  sourceScore = answers.map(a => sourceReliability(a.source)).average() * 0.2
  consistencyScore = logicalConsistency(answers) * 0.3
  uncertaintyPenalty = epistemicUncertainty(answers) * 0.2

  score = evidenceScore + sourceScore + consistencyScore - uncertaintyPenalty

  contradictions = findContradictions(answers)
  recommendations = generateRecommendations(answers, contradictions)

  verificationStatus = determineVerification(score, contradictions)

  return {
    score: clamp(score, 0, 100),
    confidence: calculateConfidence(answers),
    reasoning: generateReasoning(answers, score),
    contradictions,
    recommendations,
    verificationStatus,
  }
```

### Evidence Quality Scoring

| Evidence Type | Score |
|---------------|-------|
| Peer-reviewed paper | 90-100 |
| Academic source | 70-89 |
| Wikipedia | 50-69 |
| OKF internal | 40-59 |
| Unverified claim | 10-39 |

### Source Reliability Weights

| Source | Weight |
|--------|--------|
| arxiv.org | 0.9 |
| wikipedia.org | 0.7 |
| OKF (validated) | 0.6 |
| DjimitKB | 0.5 |
| Unknown | 0.2 |

## Database Schema (geen nieuwe tabellen)

Bestaande tabellen worden hergebruikt:
- `swarm_capabilities` — expert agent profiles
- `memory_candidates` — knowledge results
- `agent_reflections` — judge verdicts
- `worker_leases` — sub-agent tracking

Nieuwe tabellen (minimaal):
```sql
CREATE TABLE IF NOT EXISTS expert_swarm_history (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_adapter_cache (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kac_hash ON knowledge_adapter_cache(query_hash);
CREATE INDEX IF NOT EXISTS idx_kac_expires ON knowledge_adapter_cache(expires_at);
```

## Integration Points

### Server Startup (index.ts)
```typescript
// After existing services
const orchestrator = new ExpertSwarmOrchestrator(db, nestedSpawns, skills, judge, knowledge);
console.log('🎓 Expert Swarm Orchestrator ready.');
```

### REST API (swarms.ts)
```
POST /swarms/expert/dispatch — start expert swarm
GET  /swarms/expert/active  — active swarms
GET  /swarms/expert/history — swarm history
```

### Autonomous Cycle (run-autonomous-cycle.ts)
```typescript
// After goal generation
const swarmResult = await orchestrator.dispatch({
  topic: "DjimFlo architecture evolution",
  domains: ["software-engineering", "distributed-systems", "ai"],
  maxParallel: 3,
});
console.log(`   Expert swarm: score=${swarmResult.verdict.score}, confidence=${swarmResult.verdict.confidence}`);
```

## Invariants

- **I1**: Elke sub-agent heeft een timeout van 60 seconden
- **I2**: Max 10 parallelle sub-agents per dispatch
- **I3**: Knowledge graph updates zijn atomische transacties
- **I4**: Alle knowledge results krijgen een verification status
- **I5**: Externe API calls hebben rate limiting (10 req/min)
- **I6**: Judge verdicts worden opgeslagen voor audit trail
- **I7**: Swarm history bevat volledige provenance (bron → bewijs → verdict)

## Risks

| Risk | Mitigation |
|------|-----------|
| External API downtime | Graceful degradation — skip unavailable source |
| Rate limiting | Cache results (knowledge_adapter_cache table) |
| Sub-agent timeout | 60s hard timeout, mark as failed |
| Contradictory knowledge | Judge flags contradictions, human review |
| Knowledge graph corruption | Atomic transactions, rollback capability |
