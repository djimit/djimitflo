import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface SwarmEpisode {
  id: string;
  topic: string;
  domains: string[];
  steps: Array<{ role: string; action: string; outcome: string }>;
  success: boolean;
  durationMs: number;
}

export interface SkillPattern {
  id: string;
  name: string;
  description: string;
  steps: string[];
  evidence: number;
  domains: string[];
  successRate: number;
  createdAt: string;
}

export class SkillPatternMiner {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_patterns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        steps_json TEXT NOT NULL DEFAULT '[]',
        evidence INTEGER NOT NULL DEFAULT 0,
        domains_json TEXT NOT NULL DEFAULT '[]',
        success_rate REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  mineFromEpisode(episode: SwarmEpisode): SkillPattern[] {
    const patterns: SkillPattern[] = [];
    const successSteps = episode.steps.filter(s => s.outcome === 'success');
    if (successSteps.length > 0 && episode.success) {
      patterns.push(this.createPattern({
        name: `Pattern: ${episode.topic}`,
        description: `Successful action sequence for ${episode.topic}`,
        steps: successSteps.map(s => s.action),
        domains: episode.domains,
        success: episode.success,
      }));
    }
    return patterns;
  }

  mineFromEpisodes(episodes: SwarmEpisode[]): SkillPattern[] {
    return episodes.flatMap(ep => this.mineFromEpisode(ep));
  }

  getPatterns(minEvidence: number = 1, limit: number = 20): SkillPattern[] {
    const rows = this.db.prepare('SELECT * FROM skill_patterns WHERE evidence >= ? ORDER BY evidence DESC, success_rate DESC LIMIT ?').all(minEvidence, limit) as Array<{
      id: string; name: string; description: string; steps_json: string; evidence: number; domains_json: string; success_rate: number; created_at: string;
    }>;
    return rows.map(r => ({
      id: r.id, name: r.name, description: r.description,
      steps: JSON.parse(r.steps_json), evidence: r.evidence,
      domains: JSON.parse(r.domains_json), successRate: r.success_rate, createdAt: r.created_at,
    }));
  }

  private createPattern(input: { name: string; description: string; steps: string[]; domains: string[]; success: boolean }): SkillPattern {
    const id = randomUUID();
    this.db.prepare('INSERT INTO skill_patterns (id, name, description, steps_json, evidence, domains_json, success_rate) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(id, input.name, input.description, JSON.stringify(input.steps), JSON.stringify(input.domains), input.success ? 1 : 0);
    return { id, name: input.name, description: input.description, steps: input.steps, evidence: 1, domains: input.domains, successRate: input.success ? 1 : 0, createdAt: new Date().toISOString() };
  }
}
