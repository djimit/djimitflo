import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface Reflection {
  id: string;
  loopRunId: string;
  whatWorked: string[];
  whatFailed: string[];
  lessonsLearned: string[];
  proposedImprovements: string[];
  createdAt: string;
}

interface ReflectionRow {
  id: string;
  loop_run_id: string;
  what_worked_json: string;
  what_failed_json: string;
  lessons_learned_json: string;
  proposed_improvements_json: string;
  created_at: string;
}

export class ReflectionEngine {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reflections (
        id TEXT PRIMARY KEY,
        loop_run_id TEXT NOT NULL,
        what_worked_json TEXT NOT NULL DEFAULT '[]',
        what_failed_json TEXT NOT NULL DEFAULT '[]',
        lessons_learned_json TEXT NOT NULL DEFAULT '[]',
        proposed_improvements_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_reflection_run ON reflections(loop_run_id)');
  }

  reflectOnRun(loopRunId: string): Reflection {
    const leases = this.db.prepare(`
      SELECT capability_id, status, runtime FROM worker_leases WHERE loop_run_id = ?
    `).all(loopRunId) as Array<{ capability_id: string | null; status: string; runtime: string }>;

    const whatWorked: string[] = [];
    const whatFailed: string[] = [];
    const lessonsLearned: string[] = [];
    const proposedImprovements: string[] = [];

    for (const lease of leases) {
      if (lease.status === 'completed' && lease.capability_id) {
        whatWorked.push(`${lease.capability_id} succeeded with ${lease.runtime}`);
      } else if (lease.status === 'failed' && lease.capability_id) {
        whatFailed.push(`${lease.capability_id} failed with ${lease.runtime}`);
        lessonsLearned.push(`${lease.runtime} may not be optimal for ${lease.capability_id}`);
        proposedImprovements.push(`Try different runtime for ${lease.capability_id}`);
      }
    }

    if (whatWorked.length > 0 && whatFailed.length === 0) {
      lessonsLearned.push('All tasks succeeded — current strategy is effective');
    }
    if (whatFailed.length > whatWorked.length) {
      lessonsLearned.push('More failures than successes — review approach');
      proposedImprovements.push('Consider breaking tasks into smaller steps');
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO reflections (id, loop_run_id, what_worked_json, what_failed_json, lessons_learned_json, proposed_improvements_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, loopRunId, JSON.stringify(whatWorked), JSON.stringify(whatFailed), JSON.stringify(lessonsLearned), JSON.stringify(proposedImprovements));

    return { id, loopRunId, whatWorked, whatFailed, lessonsLearned, proposedImprovements, createdAt: now };
  }

  getReflections(limit: number = 20): Reflection[] {
    const rows = this.db.prepare('SELECT * FROM reflections ORDER BY created_at DESC LIMIT ?').all(limit) as ReflectionRow[];
    return rows.map(this.rowToReflection);
  }

  getLessonsLearned(limit: number = 10): string[] {
    const rows = this.db.prepare('SELECT lessons_learned_json FROM reflections ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ lessons_learned_json: string }>;
    const lessons: string[] = [];
    for (const row of rows) {
      lessons.push(...(JSON.parse(row.lessons_learned_json) as string[]));
    }
    return [...new Set(lessons)];
  }

  getProposedImprovements(limit: number = 10): string[] {
    const rows = this.db.prepare('SELECT proposed_improvements_json FROM reflections ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ proposed_improvements_json: string }>;
    const improvements: string[] = [];
    for (const row of rows) {
      improvements.push(...(JSON.parse(row.proposed_improvements_json) as string[]));
    }
    return [...new Set(improvements)];
  }

  private rowToReflection(row: ReflectionRow): Reflection {
    return {
      id: row.id,
      loopRunId: row.loop_run_id,
      whatWorked: JSON.parse(row.what_worked_json) as string[],
      whatFailed: JSON.parse(row.what_failed_json) as string[],
      lessonsLearned: JSON.parse(row.lessons_learned_json) as string[],
      proposedImprovements: JSON.parse(row.proposed_improvements_json) as string[],
      createdAt: row.created_at,
    };
  }
}
