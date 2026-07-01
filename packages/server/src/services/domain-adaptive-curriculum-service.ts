import type { Database } from 'better-sqlite3';

export interface DomainCurriculum {
  domain: string;
  steps: Array<{
    objective: string;
    difficulty: number;
    prerequisites: string[];
    status: 'locked' | 'available' | 'completed';
  }>;
}

interface DomainStepRow {
  id: string;
  domain: string;
  objective: string;
  difficulty: number;
  prerequisites_json: string;
  status: string;
}

export class DomainAdaptiveCurriculumService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domain_curriculum_steps (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        objective TEXT NOT NULL,
        difficulty REAL NOT NULL DEFAULT 0.5,
        prerequisites_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'locked',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  detectDomain(description: string): string {
    const lower = description.toLowerCase();
    if (lower.includes('docker') || lower.includes('kubernetes') || lower.includes('deploy')) return 'infrastructure';
    if (lower.includes('sql') || lower.includes('data') || lower.includes('etl') || lower.includes('pipeline')) return 'data';
    if (lower.includes('email') || lower.includes('telegram') || lower.includes('slack') || lower.includes('message')) return 'communication';
    if (lower.includes('research') || lower.includes('paper') || lower.includes('experiment')) return 'research';
    if (lower.includes('code') || lower.includes('typescript') || lower.includes('python') || lower.includes('refactor')) return 'code';
    return 'general';
  }

  generateCurriculum(domain: string): DomainCurriculum {
    const steps = this.getDomainSteps(domain);
    if (steps.length > 0) return { domain, steps };

    const generated = this.createDefaultSteps(domain);
    for (const step of generated) {
      const id = `step-${domain}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      this.db.prepare(`
        INSERT INTO domain_curriculum_steps (id, domain, objective, difficulty, prerequisites_json, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, domain, step.objective, step.difficulty, JSON.stringify(step.prerequisites), step.status);
    }

    return { domain, steps: generated };
  }

  getDomainSteps(domain: string): DomainCurriculum['steps'] {
    const rows = this.db.prepare(
      'SELECT objective, difficulty, prerequisites_json, status FROM domain_curriculum_steps WHERE domain = ? ORDER BY difficulty ASC'
    ).all(domain) as Array<{ objective: string; difficulty: number; prerequisites_json: string; status: string }>;

    return rows.map(r => ({
      objective: r.objective,
      difficulty: r.difficulty,
      prerequisites: JSON.parse(r.prerequisites_json) as string[],
      status: r.status as 'locked' | 'available' | 'completed',
    }));
  }

  private createDefaultSteps(domain: string): DomainCurriculum['steps'] {
    const defaults: Record<string, DomainCurriculum['steps']> = {
      infrastructure: [
        { objective: 'Understand current infrastructure', difficulty: 0.2, prerequisites: [], status: 'available' },
        { objective: 'Containerize application', difficulty: 0.4, prerequisites: ['Understand current infrastructure'], status: 'locked' },
        { objective: 'Set up orchestration', difficulty: 0.6, prerequisites: ['Containerize application'], status: 'locked' },
        { objective: 'Implement monitoring', difficulty: 0.8, prerequisites: ['Set up orchestration'], status: 'locked' },
      ],
      data: [
        { objective: 'Understand data schema', difficulty: 0.2, prerequisites: [], status: 'available' },
        { objective: 'Build ETL pipeline', difficulty: 0.5, prerequisites: ['Understand data schema'], status: 'locked' },
        { objective: 'Implement data validation', difficulty: 0.7, prerequisites: ['Build ETL pipeline'], status: 'locked' },
      ],
      communication: [
        { objective: 'Set up messaging channels', difficulty: 0.3, prerequisites: [], status: 'available' },
        { objective: 'Implement notification system', difficulty: 0.5, prerequisites: ['Set up messaging channels'], status: 'locked' },
      ],
      research: [
        { objective: 'Literature review', difficulty: 0.3, prerequisites: [], status: 'available' },
        { objective: 'Design experiment', difficulty: 0.5, prerequisites: ['Literature review'], status: 'locked' },
        { objective: 'Analyze results', difficulty: 0.7, prerequisites: ['Design experiment'], status: 'locked' },
      ],
      code: [
        { objective: 'Understand codebase', difficulty: 0.2, prerequisites: [], status: 'available' },
        { objective: 'Fix critical bugs', difficulty: 0.4, prerequisites: ['Understand codebase'], status: 'locked' },
        { objective: 'Implement features', difficulty: 0.6, prerequisites: ['Fix critical bugs'], status: 'locked' },
        { objective: 'Refactor and optimize', difficulty: 0.8, prerequisites: ['Implement features'], status: 'locked' },
      ],
    };

    return defaults[domain] || [
      { objective: `Learn ${domain} basics`, difficulty: 0.3, prerequisites: [], status: 'available' },
      { objective: `Apply ${domain} knowledge`, difficulty: 0.6, prerequisites: [`Learn ${domain} basics`], status: 'locked' },
    ];
  }
}
