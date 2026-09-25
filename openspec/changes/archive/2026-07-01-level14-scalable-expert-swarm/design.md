# Design — Level-14 Scalable Expert Swarm

## G97: Skill-Driven Expert Workers

### Wijziging: `expert-swarm-orchestrator.ts`

Huidige `executeExpert` methode:
```typescript
private async executeExpert(domain: string, topic: string, sources: string[]): Promise<ExpertAnswer | null> {
  const query = `${topic} ${domain}`;
  const results = await this.registry.searchAll(query, sources, 3);
  // ... return answer
}
```

Nieuwe `executeExpert` methode:
```typescript
private async executeExpert(domain: string, topic: string, sources: string[]): Promise<ExpertAnswer | null> {
  const skill = this.skills.getSkillForFinding(topic, domain);
  const query = skill
    ? `Given this procedure:\n${skill}\n\nResearch: ${topic} in ${domain}`
    : `${topic} ${domain}`;

  const results = await this.registry.searchAll(query, sources, 3);
  // ... return answer with skill metadata
}
```

Toegevoegd: `SkillService` injectie in constructor.

## G98: Worker Pool

### Nieuw bestand: `packages/server/src/services/worker-pool.ts` (~150 LOC)

```typescript
interface WorkerTask<T, R> {
  id: string;
  fn: (input: T) => Promise<R>;
  input: T;
  retries: number;
  maxRetries: number;
}

interface WorkerPoolOptions {
  concurrency: number;      // default: os.cpus().length * 2
  taskTimeoutMs: number;    // default: 60_000
  maxRetries: number;       // default: 2
}

export class WorkerPool {
  constructor(options: WorkerPoolOptions);
  execute<T, R>(tasks: WorkerTask<T, R>[]): Promise<Array<{ result?: R; error?: Error }>>;
  getStats(): { active: number; queued: number; completed: number; failed: number };
  shutdown(): void;
}
```

### Algoritme
```
function execute(tasks):
  results = []
  queue = [...tasks]
  active = 0

  return new Promise((resolve) => {
    function next():
      while active < concurrency && queue.length > 0:
        task = queue.shift()
        active++
        executeTask(task).then(result => {
          results.push(result)
          active--
          if results.length === tasks.length: resolve(results)
          else next()
        })

    next()
  })

function executeTask(task):
  try:
    result = await Promise.race([task.fn(task.input), timeout(timeoutMs)])
    return { result }
  catch error:
    if task.retries < task.maxRetries:
      task.retries++
      return executeTask(task)  // retry
    return { error }
```

## G99: Judge Human-in-the-Loop

### Wijziging: `judge-service.ts`

Nieuwe methode:
```typescript
getApprovalAction(verdict: JudgeVerdict): 'auto_approve' | 'human_review' | 'reject' {
  if (verdict.score >= 80 && verdict.contradictions.length === 0) return 'auto_approve';
  if (verdict.score >= 60) return 'human_review';
  return 'reject';
}
```

### Integratie: `operator-interductie.ts`

Voeg review request toe:
```typescript
requestIntervention(
  `Judge review: score=${verdict.score}, topic=${topic}`,
  { verdict, answers, topic }
)
```

## G100: OKF Knowledge Graph Update

### Nieuw bestand: `packages/server/src/services/okf-knowledge-updater.ts` (~120 LOC)

```typescript
export class OkfKnowledgeUpdater {
  constructor(private db: Database);

  async updateFromVerdict(topic: string, answers: ExpertAnswer[], verdict: JudgeVerdict): Promise<boolean>;
  async createConcept(topic: string, content: string, sources: KnowledgeResult[]): Promise<string>;
  async updateConcept(existingId: string, newEvidence: string): Promise<void>;
  async linkSources(conceptId: string, sources: KnowledgeResult[]): Promise<void>;
}
```

### OKF Concept Format
```markdown
---
type: Concept
title: "{topic}"
confidence: {verdict.confidence}
verification: {verdict.verification_status}
sources: [{source.url}]
domains: [{domains}]
updated: {timestamp}
---

# {topic}

{content}

## Sources
- {source.title}: {source.url}
```

## G101: Skill Evolution

### Wijziging: `skill-distillation-service.ts`

Nieuwe methode:
```typescript
async analyzeSkillPerformance(skillId: string, executionResults: ExpertAnswer[]): Promise<SkillImprovement[]> {
  const skill = this.getSkill(skillId);
  const improvements: SkillImprovement[] = [];

  for (const result of executionResults) {
    if (result.confidence < 0.5) {
      improvements.push({
        type: 'clarity',
        description: `Low confidence (${result.confidence}) — skill procedure may be unclear for domain "${result.domain}"`,
      });
    }
  }

  return improvements;
}
```

## G102: Integration

### Server Startup (index.ts)
```typescript
const workerPool = new WorkerPool({ concurrency: 10 });
const okfUpdater = new OkfKnowledgeUpdater(db);
const orchestrator = new ExpertSwarmOrchestrator(db, nestedSpawns, skills, judge, knowledge, workerPool, okfUpdater);
```

### REST API (swarms.ts)
```
POST /swarms/expert/dispatch  — start expert swarm (uitgebreid met skill/source selection)
GET  /swarms/expert/active    — active swarms met worker status
GET  /swarms/expert/history   — swarm history met verdicts
GET  /swarms/expert/review    — pending human reviews
POST /swarms/expert/review/:id — approve/reject review
```

### Autonomous Cycle (run-autonomous-cycle.ts)
```typescript
// Weekly expert swarm
const swarmResult = await orchestrator.dispatch({
  topic: 'DjimFlo autonomous evolution',
  domains: ['software-engineering', 'artificial-intelligence', 'complexity-science'],
  maxParallel: 5,
  sources: ['wikipedia', 'arxiv'],
  useSkills: true,
});
```

## Invariants

- **I1 Worker limit**: Max 10 parallel workers
- **I2 Timeout**: 60s per worker, 2 retries
- **I3 Rate limit**: 10 req/min per external source
- **I4 Human review**: Score 60-79 → pending review
- **I5 OKF format**: Alle concepten hebben frontmatter + bronnen
- **I6 Skill feedback**: Post-run analyse bij elke swarm
- **I7 Provenance**: Volledige trace (bron → bewijs → verdict → actie)

## Risks

| Risk | Mitigation |
|------|-----------|
| Worker pool overload | Concurrency limit + queue |
| External API downtime | Graceful degradation + cache |
| OKF write conflicts | Atomic transactions |
| Skill degradation | Versioned skill updates |
| Judge bias | Multi-dimension scoring |
