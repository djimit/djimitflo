import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface ImprovementProposal {
  id: string;
  type: 'bug_fix' | 'feature' | 'refactor' | 'performance' | 'security';
  title: string;
  description: string;
  rationale: string;
  source: 'reflection' | 'invention' | 'gap_analysis' | 'feedback';
  status: 'proposed' | 'approved' | 'in_progress' | 'completed' | 'rejected';
  priority: number;
  createdAt: string;
}

interface ImprovementRow {
  id: string;
  type: string;
  title: string;
  description: string;
  rationale: string;
  source: string;
  status: string;
  priority: number;
  created_at: string;
}

export class SelfImprovementService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS self_improvements (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        rationale TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        priority REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_self_improve_status ON self_improvements(status)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_self_improve_priority ON self_improvements(priority DESC)');
  }

  generateFromReflection(reflection: { whatFailed: string[]; lessonsLearned: string[]; proposedImprovements: string[] }): ImprovementProposal[] {
    const proposals: ImprovementProposal[] = [];

    for (const improvement of reflection.proposedImprovements) {
      const id = randomUUID();
      const type = this.classifyImprovement(improvement);
      const proposal: ImprovementProposal = {
        id,
        type,
        title: improvement.slice(0, 80),
        description: improvement,
        rationale: reflection.lessonsLearned.join('; ') || 'Generated from reflection',
        source: 'reflection',
        status: 'proposed',
        priority: type === 'bug_fix' ? 0.9 : type === 'security' ? 0.95 : 0.6,
        createdAt: new Date().toISOString(),
      };

      this.db.prepare(`
        INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority)
        VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)
      `).run(id, type, proposal.title, proposal.description, proposal.rationale, 'reflection', proposal.priority);

      proposals.push(proposal);
    }

    return proposals;
  }

  generateFromGaps(gaps: Array<{ domain: string; description: string }>): ImprovementProposal[] {
    const proposals: ImprovementProposal[] = [];

    for (const gap of gaps) {
      const id = randomUUID();
      const proposal: ImprovementProposal = {
        id,
        type: 'feature',
        title: `Address knowledge gap: ${gap.domain}`,
        description: gap.description,
        rationale: `Knowledge gap identified in domain '${gap.domain}'`,
        source: 'gap_analysis',
        status: 'proposed',
        priority: 0.7,
        createdAt: new Date().toISOString(),
      };

      this.db.prepare(`
        INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority)
        VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)
      `).run(id, 'feature', proposal.title, proposal.description, proposal.rationale, 'gap_analysis', 0.7);

      proposals.push(proposal);
    }

    return proposals;
  }

  generateFromBuildErrors(errors: string[]): ImprovementProposal[] {
    const proposals: ImprovementProposal[] = [];

    for (const error of errors.slice(0, 5)) {
      const id = randomUUID();
      const proposal: ImprovementProposal = {
        id,
        type: 'bug_fix',
        title: `Fix: ${error.slice(0, 60)}`,
        description: error,
        rationale: 'Build/test failure detected',
        source: 'feedback',
        status: 'proposed',
        priority: 0.95,
        createdAt: new Date().toISOString(),
      };

      this.db.prepare(`
        INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority)
        VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)
      `).run(id, 'bug_fix', proposal.title, proposal.description, proposal.rationale, 'feedback', 0.95);

      proposals.push(proposal);
    }

    return proposals;
  }

  getProposedImprovements(): ImprovementProposal[] {
    const rows = this.db.prepare("SELECT * FROM self_improvements WHERE status = 'proposed' ORDER BY priority DESC").all() as ImprovementRow[];
    return rows.map(this.rowToProposal);
  }

  getImprovementHistory(limit: number = 20): ImprovementProposal[] {
    const rows = this.db.prepare('SELECT * FROM self_improvements ORDER BY created_at DESC LIMIT ?').all(limit) as ImprovementRow[];
    return rows.map(this.rowToProposal);
  }

  approveImprovement(id: string): void {
    this.db.prepare("UPDATE self_improvements SET status = 'approved' WHERE id = ?").run(id);
  }

  completeImprovement(id: string): void {
    this.db.prepare("UPDATE self_improvements SET status = 'completed' WHERE id = ?").run(id);
  }

  rejectImprovement(id: string): void {
    this.db.prepare("UPDATE self_improvements SET status = 'rejected' WHERE id = ?").run(id);
  }

  private classifyImprovement(text: string): ImprovementProposal['type'] {
    const lower = text.toLowerCase();
    if (lower.includes('security') || lower.includes('vulnerability')) return 'security';
    if (lower.includes('performance') || lower.includes('slow') || lower.includes('optimize')) return 'performance';
    if (lower.includes('refactor') || lower.includes('cleanup') || lower.includes('restructure')) return 'refactor';
    if (lower.includes('fix') || lower.includes('bug') || lower.includes('error')) return 'bug_fix';
    return 'feature';
  }

  private rowToProposal(row: ImprovementRow): ImprovementProposal {
    return {
      id: row.id,
      type: row.type as ImprovementProposal['type'],
      title: row.title,
      description: row.description,
      rationale: row.rationale,
      source: row.source as ImprovementProposal['source'],
      status: row.status as ImprovementProposal['status'],
      priority: row.priority,
      createdAt: row.created_at,
    };
  }
}
