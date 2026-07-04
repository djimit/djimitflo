import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { SwarmEpisode, SkillPattern } from './skill-pattern-miner';
import { SkillPatternMiner } from './skill-pattern-miner';
import { PromptPatternRegistry } from './prompt-pattern-registry';

export interface GymEvaluation {
  id: string; skillId: string; score: number; metrics: Record<string, number>; timestamp: string;
}

export interface ExplorationResult {
  domain: string; patternsFound: number; topPattern: string | null; recommendation: string;
}

export class SkillEvolutionGym {
  private miner: SkillPatternMiner;
  private prompts: PromptPatternRegistry;

  constructor(private db: Database) {
    this.miner = new SkillPatternMiner(db);
    this.prompts = new PromptPatternRegistry(db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS gym_evaluations (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      score REAL NOT NULL,
      metrics_json TEXT NOT NULL,
      eval_type TEXT NOT NULL DEFAULT 'functional' CHECK(eval_type IN ('functional', 'governance_benchmark')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  }

  evaluateSkill(skillId: string, metrics: Record<string, number>): GymEvaluation {
    const id = randomUUID();
    const score = Object.values(metrics).reduce((sum, v) => sum + v, 0) / Math.max(1, Object.keys(metrics).length);
    this.db.prepare('INSERT INTO gym_evaluations (id, skill_id, score, metrics_json) VALUES (?, ?, ?, ?)').run(id, skillId, score, JSON.stringify(metrics));
    return { id, skillId, score, metrics, timestamp: new Date().toISOString() };
  }

  exploreDomain(domain: string): ExplorationResult {
    const patterns = this.miner.getPatterns(1, 20);
    const domainPatterns = patterns.filter(p => p.domains.includes(domain));
    const promptPatterns = this.prompts.getPatternsForDomain(domain, 5);
    let recommendation = `No patterns found for "${domain}" — consider generating swarm episodes`;
    if (domainPatterns.length > 0) recommendation = `Found ${domainPatterns.length} patterns — top: "${domainPatterns[0].name}"`;
    else if (promptPatterns.length > 0) recommendation = `No skill patterns, but ${promptPatterns.length} prompt patterns available`;
    return { domain, patternsFound: domainPatterns.length, topPattern: domainPatterns[0]?.name ?? null, recommendation };
  }

  ingestEpisode(episode: SwarmEpisode): { patterns: SkillPattern[]; evaluation: GymEvaluation | null } {
    const patterns = this.miner.mineFromEpisode(episode);
    let evaluation: GymEvaluation | null = null;
    if (patterns.length > 0) {
      evaluation = this.evaluateSkill(patterns[0].id, { success: episode.success ? 1 : 0, duration: Math.min(1, episode.durationMs / 60000), steps: episode.steps.length });
    }
    return { patterns, evaluation };
  }

  getLeaderboard(limit: number = 10): Array<{ skillId: string; avgScore: number; evaluations: number }> {
    try {
      const rows = this.db.prepare('SELECT skill_id, AVG(score) as avg_score, COUNT(*) as count FROM gym_evaluations GROUP BY skill_id ORDER BY avg_score DESC LIMIT ?').all(limit) as Array<{ skill_id: string; avg_score: number; count: number }>;
      return rows.map(r => ({ skillId: r.skill_id, avgScore: r.avg_score, evaluations: r.count }));
    } catch { return []; }
  }

  getStats(): { totalEvaluations: number; totalPatterns: number; domains: string[] } {
    let totalEvaluations = 0;
    try { const row = this.db.prepare('SELECT COUNT(*) as c FROM gym_evaluations').get() as { c: number }; totalEvaluations = row.c; } catch { /* ok */ }
    const patterns = this.miner.getPatterns(1, 100);
    return { totalEvaluations, totalPatterns: patterns.length, domains: [...new Set(patterns.flatMap(p => p.domains))] };
  }

  /**
   * Run governance benchmark evaluation for a skill.
   */
  async runGovernanceEvaluation(skillId: string, categories?: string[]): Promise<{
    score: number;
    passed: boolean;
    categoryScores: Record<string, number>;
  }> {
    const { OpenMythosEvalService } = await import('./openmythos-eval-service');
    const evalService = new OpenMythosEvalService(this.db);
    const result = await evalService.runEval(skillId, categories);

    const normalizedScore = result.overallScore / 5;
    const passed = result.overallScore >= 3.5; // Minimum threshold for gym

    // Store in gym_evaluations with governance type
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO gym_evaluations (id, skill_id, score, metrics_json, eval_type)
      VALUES (?, ?, ?, ?, 'governance_benchmark')
    `).run(id, skillId, normalizedScore, JSON.stringify({
      overallScore: result.overallScore,
      categoryScores: result.categoryScores,
      passed,
    }));

    return { score: result.overallScore, passed, categoryScores: result.categoryScores };
  }

  /**
   * Get governance evaluation history for a skill.
   */
  getGovernanceHistory(skillId: string, limit = 10): Array<{
    score: number;
    passed: boolean;
    timestamp: string;
  }> {
    try {
      const rows = this.db.prepare(`
        SELECT score, metrics_json, created_at
        FROM gym_evaluations
        WHERE skill_id = ? AND eval_type = 'governance_benchmark'
        ORDER BY created_at DESC
        LIMIT ?
      `).all(skillId, limit) as Array<{ score: number; metrics_json: string; created_at: string }>;

      return rows.map((r) => {
        let passed = false;
        try { passed = JSON.parse(r.metrics_json).passed; } catch { /* ok */ }
        return { score: r.score * 5, passed, timestamp: r.created_at };
      });
    } catch { return []; }
  }
}
