# Level-13: Expert Judge Swarm — Autonomous Knowledge Evolution

## Why

DjimFlo Level-12 heeft een werkende feedback loop: self-analysis → improvements → goals → execution → learning → memory. Maar de kennis die wordt gegenereerd is **statisch** — het systeem haalt geen kennis op uit externe bronnen, heeft geen expert agents die een onderwerp diep analyseren, en heeft geen judge mechanisme om kwaliteit te evalueren.

De gebruiker vraagt zich af: hoe bouw je een systeem dat:
1. **Experts inschakelt** met specifieke skills om kennis op te halen
2. **Sub-agents schaalt** — meerdere experts parallel aan één onderwerp laten werken
3. **Een judge** de kwaliteit van antwoorden evalueert
4. **Kennis evolueert** door continue vergelijking en verificatie

## Thesis

Door bestaande services te koppelen (Ponytail: hergebruik wat er is) creëren we een **Expert Swarm** die:
- Een onderwerp ontvangt
- N expert agents parallel lanceert (elk met een skill + kennisbron)
- Antwoorden verzamelt en door een judge laat evalueren
- De conclusie opslaat in de knowledge graph

Dit is geen AI theater — het is het koppelen van bestaande functionaliteit via een orchestratie-laag.

## What Changes

### G93: Expert Swarm Orchestrator
**Bestand**: `packages/server/src/services/expert-swarm-orchestrator.ts`

Koppelt bestaande services:
- `NestedSpawnService` — sub-agents spawnen
- `SkillService` — skills injecteren als context
- `SpecialistPanelService` — expert profiles beheren
- `KnowledgeRuntimeService` — knowledge graph updaten

**Interface**:
```typescript
interface ExpertSwarmInput {
  topic: string;
  domains: string[];        // ["math", "physics", "biology"]
  maxParallel: number;     // default 3
  sources: string[];       // ["wikipedia", "arxiv", "okf"]
}

interface ExpertSwarmResult {
  topic: string;
  expertAnswers: ExpertAnswer[];
  verdict: JudgeVerdict;
  knowledgeUpdated: boolean;
}
```

**Flow**:
```
dispatch(topic, domains)
  → for each domain: NestedSpawnService.requestSpawn(skill + source)
  → collect answers
  → JudgeService.evaluate(answers)
  → KnowledgeRuntimeService.update(verdict)
```

### G94: Knowledge Source Adapters
**Bestand**: `packages/server/src/services/knowledge-adapters/` (directory)

Elke adapter implementeert:
```typescript
interface KnowledgeSourceAdapter {
  name: string;
  search(query: string): Promise<KnowledgeResult[]>;
  fetch(id: string): Promise<KnowledgeResult>;
}

interface KnowledgeResult {
  id: string;
  title: string;
  content: string;
  source: string;
  url?: string;
  confidence: number;
  metadata: Record<string, unknown>;
}
```

**Adapters**:
1. `WikipediaAdapter` — Wikipedia REST API (gratis, geen auth)
2. `ArxivAdapter` — arXiv API voor academic papers
3. `OkfAdapter` — lokale OKF knowledge base (hergebruikt bestaande OKF integratie)
4. `DjimitKBAdapter` — DjimitKB via MCP bridge (hergebruukt bestaande MCP connectie)

### G95: Judge Verdict Service
**Bestand**: `packages/server/src/services/judge-service.ts`

Evalueert expert antwoorden op 4 dimensies:

| Dimensie | Bron | Gewicht |
|----------|------|---------|
| Evidence quality | EvidenceService | 30% |
| Source reliability | Adapter metadata | 20% |
| Logical consistency | DAGConsensusService | 30% |
| Epistemic uncertainty | EpistemicUncertaintyService | 20% |

**Output**:
```typescript
interface JudgeVerdict {
  score: number;           // 0-100
  confidence: number;      // 0-1
  reasoning: string;
  contradictions: string[];
  recommendations: string[];
  verificationStatus: 'verified' | 'pending' | 'contradicted' | 'unverifiable';
}
```

## Non-Goals

- Geen biologische evolutie simulatie (ethisch onverantwoord)
- Geen volledige academic paper NLP parsing (te complex, laat aan externe tools)
- Geen autonomie zonder menselijk toezicht (judge heeft altijd human-in-the-loop)
- Geen nieuwe database tabellen — gebruik bestaande (swarm_capabilities, memory_candidates, agent_reflections)

## Guardrails

- Max 10 parallelle sub-agents per onderwerp (resource besparing)
- Elke sub-agent heeft 60s timeout (voorkomt hangende workers)
- Rate limiting op externe APIs (max 10 req/min per source)
- Alle gegenereerde kennis krijgt verification status
- Rollback capability: knowledge graph updates zijn atomische transacties

## Success Criteria

| Metric | Target |
|--------|--------|
| Expert agents | ≥ 3 domains parallel |
| Knowledge sources | ≥ 4 adapters |
| Judge score correlation | ≥ 0.7 met human expert |
| Tests | ≥ 36 new tests |
| Sub-agent scalability | 10 parallel workers |
| Knowledge graph updates | ≥ 1 per swarm dispatch |
