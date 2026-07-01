import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { KnowledgeAdapterRegistry } from './knowledge-adapters';
import { JudgeService, type ExpertAnswer, type JudgeVerdict } from './judge-service';
import { SkillService } from './skill-service';

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
  private maxParallel = 10;

  constructor(private db: Database) {
    this.registry = new KnowledgeAdapterRegistry(db);
    this.judge = new JudgeService(db);
    this.skills = new SkillService(db);

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
    const maxParallel = Math.min(input.maxParallel ?? 3, this.maxParallel);
    const sources = input.sources ?? ['wikipedia', 'arxiv', 'okf'];

    const answers: ExpertAnswer[] = [];

    const domainChunks = this.chunkArray(input.domains, maxParallel);

    for (const chunk of domainChunks) {
      const chunkPromises = chunk.map(domain => this.executeExpert(domain, input.topic, sources));
      const chunkResults = await Promise.allSettled(chunkPromises);

      for (const result of chunkResults) {
        if (result.status === 'fulfilled' && result.value) {
          answers.push(result.value);
        }
      }
    }

    const verdict = this.judge.evaluate(answers);
    const knowledgeUpdated = verdict.score >= 60;

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
      duration_ms: Date.now() - start,
      created_at: new Date().toISOString(),
    };

    this.db.prepare('INSERT INTO expert_swarm_history (id, result_json) VALUES (?, ?)').run(id, JSON.stringify(result));

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
