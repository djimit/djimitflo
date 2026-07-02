import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { CuriosityService } from './curiosity-service';

export interface ExplorationGoal {
  id: string;
  domain: string;
  curiosityScore: number;
  status: 'proposed' | 'active' | 'completed';
  createdAt: string;
}

export interface ExplorationStats {
  totalExplorations: number;
  activeExplorations: number;
  completedExplorations: number;
  averageCuriosityScore: number;
}

interface ExplorationRow {
  id: string;
  domain: string;
  curiosity_score: number;
  status: string;
  created_at: string;
}

export class IntrinsicMotivationModule {
  constructor(
    private db: Database,
    private curiosity: CuriosityService,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exploration_goals (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        curiosity_score REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_exploration_status ON exploration_goals(status)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_exploration_domain ON exploration_goals(domain)');
  }

  async generateNovelGoals(): Promise<ExplorationGoal[]> {
    const gapReport = await this.curiosity.scanForGaps();
    const goals: ExplorationGoal[] = [];

    for (const gap of gapReport.gaps.slice(0, 3)) {
      const existing = this.db.prepare('SELECT id FROM exploration_goals WHERE domain = ? AND status = ?').get(gap.domain, 'proposed');
      if (existing) continue;

      const id = randomUUID();
      const curiosityScore = gap.severity;

      this.db.prepare(`
        INSERT INTO exploration_goals (id, domain, curiosity_score, status)
        VALUES (?, ?, ?, 'proposed')
      `).run(id, gap.domain, curiosityScore);

      goals.push({ id, domain: gap.domain, curiosityScore, status: 'proposed', createdAt: new Date().toISOString() });
    }

    return goals;
  }

  scoreCuriosity(domain: string): number {
    try {
      const conceptCount = this.db.prepare('SELECT COUNT(*) as c FROM swarm_claims WHERE subject_ref = ?').get(domain) as { c: number };
      const knownConcepts = conceptCount.c;
      if (knownConcepts === 0) return 0.9;
      if (knownConcepts < 3) return 0.7;
      if (knownConcepts < 10) return 0.4;
      return 0.2;
    } catch { return 0.5; }
  }

  exploreNewDomain(domain: string): { started: boolean; goalId?: string } {
    const existing = this.db.prepare('SELECT id FROM exploration_goals WHERE domain = ? AND status = ?').get(domain, 'active');
    if (existing) return { started: false };

    const id = randomUUID();
    const score = this.scoreCuriosity(domain);

    this.db.prepare(`
      INSERT INTO exploration_goals (id, domain, curiosity_score, status)
      VALUES (?, ?, ?, 'active')
    `).run(id, domain, score);

    return { started: true, goalId: id };
  }

  getExplorationStats(): ExplorationStats {
    const rows = this.db.prepare('SELECT curiosity_score, status FROM exploration_goals').all() as Array<{ curiosity_score: number; status: string }>;
    return {
      totalExplorations: rows.length,
      activeExplorations: rows.filter(r => r.status === 'active').length,
      completedExplorations: rows.filter(r => r.status === 'completed').length,
      averageCuriosityScore: rows.length > 0 ? rows.reduce((sum, r) => sum + r.curiosity_score, 0) / rows.length : 0,
    };
  }

  getProposedGoals(limit: number = 10): ExplorationGoal[] {
    const rows = this.db.prepare("SELECT * FROM exploration_goals WHERE status = 'proposed' ORDER BY curiosity_score DESC LIMIT ?").all(limit) as ExplorationRow[];
    return rows.map(r => ({
      id: r.id,
      domain: r.domain,
      curiosityScore: r.curiosity_score,
      status: r.status as ExplorationGoal['status'],
      createdAt: r.created_at,
    }));
  }

  completeExploration(goalId: string): void {
    this.db.prepare("UPDATE exploration_goals SET status = 'completed' WHERE id = ?").run(goalId);
  }
}
