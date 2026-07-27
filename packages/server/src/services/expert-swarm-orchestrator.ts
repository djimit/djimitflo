import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { KnowledgeAdapterRegistry } from './knowledge-adapters';
import { JudgeService, type ExpertAnswer, type JudgeVerdict } from './judge-service';
import { SkillService } from './skill-service';
import { AgentAssuranceService } from './agent-assurance-service';

export interface ExpertSwarmInput {
  topic: string;
  domains: string[];
  maxParallel?: number;
  sources?: string[];
}

export interface ExpertSwarmResult {
  id: string;
  topic: string;
  domains: string[];
  expert_answers: ExpertAnswer[];
  verdict: JudgeVerdict;
  knowledge_updated: boolean;
  retry_count: number;
  trace_id: string;
  duration_ms: number;
  created_at: string;
}

interface SwarmRow {
  id: string;
  result_json: string;
  created_at: string;
}

export class ExpertSwarmOrchestrator {
  private registry: KnowledgeAdapterRegistry;
  private judge: JudgeService;
  private skills: SkillService;
  private assurance: AgentAssuranceService;
  private maxParallel = 10;

  constructor(private db: Database) {
    this.registry = new KnowledgeAdapterRegistry(db);
    this.judge = new JudgeService(db);
    this.skills = new SkillService(db);
    this.assurance = new AgentAssuranceService(db);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS expert_swarm_history (
        id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_swarm_history_created ON expert_swarm_history(created_at DESC)');
  }

  async dispatch(input: ExpertSwarmInput): Promise<ExpertSwarmResult> {
    const start = Date.now();
    const id = randomUUID();
    const traceId = `expert-swarm:${id}`;
    const rootSpan = this.assurance.createTraceSpan({
      trace_id: traceId,
      span_type: 'capability',
      name: 'expert-swarm',
      status: 'running',
      evidence_ref: `expert-swarm:${id}`,
      metadata: { topic: input.topic, domains: input.domains },
    });
    const maxParallel = Math.min(input.maxParallel ?? 3, this.maxParallel);
    const sources = input.sources ?? ['wikipedia', 'arxiv', 'okf'];

    const answers = await this.executeDomains(input.domains, input.topic, sources, maxParallel);
    this.recordAttempt(traceId, rootSpan.id, 1, sources, answers);

    let verdict = this.judge.evaluate(answers);
    let retryCount = 0;
    const failedDomains = input.domains.filter((domain) => {
      const answer = answers.find((candidate) => candidate.domain === domain);
      return !answer?.evidence_refs?.length;
    });
    const fallbackSources = this.registry.getAvailable().filter((source) => !sources.includes(source));
    if (verdict.score < 60 && failedDomains.length > 0 && fallbackSources.length > 0) {
      const retried = await this.executeDomains(failedDomains, input.topic, fallbackSources, maxParallel);
      retryCount = 1;
      this.recordAttempt(traceId, rootSpan.id, 2, fallbackSources, retried);
      for (const retryAnswer of retried) {
        const index = answers.findIndex((answer) => answer.domain === retryAnswer.domain);
        if (retryAnswer.evidence_refs?.length && index >= 0) answers[index] = retryAnswer;
      }
      verdict = this.judge.evaluate(answers);
    }
    const knowledgeUpdated = verdict.score >= 60;
    this.assurance.createTraceSpan({
      trace_id: traceId,
      parent_span_id: rootSpan.id,
      span_type: 'eval',
      name: 'judge',
      status: knowledgeUpdated ? 'ok' : 'blocked',
      evidence_ref: `judge:${verdict.id}`,
      metadata: { score: verdict.score, confidence: verdict.confidence, retry_count: retryCount },
    });

    if (knowledgeUpdated) {
      this.storeKnowledge(input.topic, answers, verdict);
    }

    const result: ExpertSwarmResult = {
      id,
      topic: input.topic,
      domains: input.domains,
      expert_answers: answers,
      verdict,
      knowledge_updated: knowledgeUpdated,
      retry_count: retryCount,
      trace_id: traceId,
      duration_ms: Date.now() - start,
      created_at: new Date().toISOString(),
    };

    this.db.prepare('INSERT INTO expert_swarm_history (id, result_json) VALUES (?, ?)').run(id, JSON.stringify(result));
    this.db.prepare(`
      UPDATE agent_trace_spans
      SET status = ?, ended_at = ?, metadata = json_set(metadata, '$.knowledge_updated', ?, '$.retry_count', ?)
      WHERE id = ?
    `).run(knowledgeUpdated ? 'ok' : 'blocked', new Date().toISOString(), knowledgeUpdated ? 1 : 0, retryCount, rootSpan.id);

    return result;
  }

  getHistory(limit: number = 20): ExpertSwarmResult[] {
    const rows = this.db.prepare('SELECT result_json FROM expert_swarm_history ORDER BY created_at DESC LIMIT ?').all(limit) as SwarmRow[];
    return rows.map(r => JSON.parse(r.result_json) as ExpertSwarmResult);
  }

  getAvailableSources(): string[] {
    return this.registry.getAvailable();
  }

  private async executeExpert(domain: string, topic: string, sources: string[]): Promise<ExpertAnswer | null> {
    try {
      const skill = this.skills.getSkillForFinding(topic, domain);
      const query = skill
        ? `Given this procedure:\n${skill}\n\nResearch: ${topic} in ${domain}`
        : `${topic} ${domain}`;

      const results = await this.registry.searchAll(query, sources, 3);

      if (results.length === 0) {
        return {
          domain,
          content: `No knowledge found for "${topic}" in domain "${domain}".`,
          source: 'none',
          confidence: 0.1,
          evidence_refs: [],
          metadata: { skill_used: !!skill },
        };
      }

      const bestResult = results.reduce((best, r) => r.confidence > best.confidence ? r : best, results[0]);

      return {
        domain,
        content: bestResult.content,
        source: bestResult.source,
        confidence: bestResult.confidence,
        evidence_refs: [bestResult.id],
        metadata: {
          url: bestResult.url,
          title: bestResult.title,
          all_sources: results.map(r => r.source),
          skill_used: !!skill,
          skill_procedure: skill ? skill.slice(0, 200) : null,
        },
      };
    } catch {
      return null;
    }
  }

  private async executeDomains(domains: string[], topic: string, sources: string[], maxParallel: number): Promise<ExpertAnswer[]> {
    const answers: ExpertAnswer[] = [];
    for (const chunk of this.chunkArray(domains, maxParallel)) {
      const results = await Promise.allSettled(chunk.map((domain) => this.executeExpert(domain, topic, sources)));
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) answers.push(result.value);
      }
    }
    return answers;
  }

  private recordAttempt(traceId: string, parentSpanId: string, attempt: number, sources: string[], answers: ExpertAnswer[]): void {
    for (const answer of answers) {
      this.assurance.createTraceSpan({
        trace_id: traceId,
        parent_span_id: parentSpanId,
        span_type: 'worker',
        name: `expert:${answer.domain}:attempt-${attempt}`,
        status: answer.evidence_refs?.length ? 'ok' : 'error',
        evidence_ref: answer.evidence_refs?.[0] || null,
        metadata: { attempt, sources, selected_source: answer.source, confidence: answer.confidence },
      });
    }
  }

  private storeKnowledge(topic: string, answers: ExpertAnswer[], verdict: JudgeVerdict): void {
    try {
      const content = answers.map(a => `[${a.domain}] ${a.content}`).join('\n\n');
      this.db.prepare(`
        INSERT OR IGNORE INTO memory_candidates (id, title, content, memory_type, source_ref, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'expert_knowledge', ?, ?, datetime('now'), datetime('now'))
      `).run(
        randomUUID(),
        `Expert knowledge: ${topic}`,
        content,
        `expert-swarm:${topic}`,
        JSON.stringify({ verdict_score: verdict.score, confidence: verdict.confidence, domains: answers.map(a => a.domain) })
      );
    } catch { /* best-effort */ }
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
