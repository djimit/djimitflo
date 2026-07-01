import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface Skill {
  id: string;
  intentEmbedding: string;
  procedure: Record<string, unknown>;
  successCount: number;
  failCount: number;
  lastUsed: string | null;
  createdAt: string;
}

export interface CausalEdge {
  id: string;
  causeRef: string;
  effectRef: string;
  strength: number;
  evidenceCount: number;
  createdAt: string;
}

interface SkillRow {
  id: string;
  intent_embedding: string;
  procedure_json: string;
  success_count: number;
  fail_count: number;
  last_used: string | null;
  created_at: string;
}

interface CausalRow {
  id: string;
  cause_ref: string;
  effect_ref: string;
  strength: number;
  evidence_count: number;
  created_at: string;
}

export class CognitiveMemoryService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_library (
        id TEXT PRIMARY KEY,
        intent_embedding TEXT NOT NULL,
        procedure_json TEXT NOT NULL,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS causal_edges (
        id TEXT PRIMARY KEY,
        cause_ref TEXT NOT NULL,
        effect_ref TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        evidence_count INTEGER DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_skill_success ON skill_library(success_count)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_causal_cause ON causal_edges(cause_ref)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_causal_effect ON causal_edges(effect_ref)');
  }

  storeSkill(intent: string, procedure: Record<string, unknown>): Skill {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO skill_library (id, intent_embedding, procedure_json, success_count, fail_count)
      VALUES (?, ?, ?, 0, 0)
    `).run(id, intent, JSON.stringify(procedure));
    return { id, intentEmbedding: intent, procedure, successCount: 0, failCount: 0, lastUsed: null, createdAt: now };
  }

  retrieveSkills(intent: string, limit: number = 5): Skill[] {
    const pattern = `%${intent}%`;
    const rows = this.db.prepare(
      'SELECT * FROM skill_library WHERE intent_embedding LIKE ? ORDER BY success_count DESC, last_used DESC LIMIT ?'
    ).all(pattern, limit) as SkillRow[];
    return rows.map(this.rowToSkill);
  }

  recordSuccess(skillId: string): void {
    this.db.prepare(`
      UPDATE skill_library SET success_count = success_count + 1, last_used = datetime('now') WHERE id = ?
    `).run(skillId);
  }

  recordFailure(skillId: string): void {
    this.db.prepare(`
      UPDATE skill_library SET fail_count = fail_count + 1, last_used = datetime('now') WHERE id = ?
    `).run(skillId);
  }

  recordCausalEdge(cause: string, effect: string, strength: number): void {
    const existing = this.db.prepare(
      'SELECT id, evidence_count FROM causal_edges WHERE cause_ref = ? AND effect_ref = ?'
    ).get(cause, effect) as { id: string; evidence_count: number } | undefined;

    if (existing) {
      const newStrength = (strength + existing.evidence_count * 0.5) / (existing.evidence_count + 1);
      this.db.prepare(
        'UPDATE causal_edges SET strength = ?, evidence_count = evidence_count + 1 WHERE id = ?'
      ).run(newStrength, existing.id);
    } else {
      this.db.prepare(`
        INSERT INTO causal_edges (id, cause_ref, effect_ref, strength, evidence_count)
        VALUES (?, ?, ?, ?, 1)
      `).run(randomUUID(), cause, effect, strength);
    }
  }

  explainCausation(ref: string): CausalEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM causal_edges WHERE cause_ref = ? OR effect_ref = ?
      ORDER BY strength DESC
    `).all(ref, ref) as CausalRow[];
    return rows.map(this.rowToCausal);
  }

  getSkillStats(skillId: string): { success: number; fail: number; rate: number } {
    const row = this.db.prepare('SELECT success_count, fail_count FROM skill_library WHERE id = ?').get(skillId) as { success_count: number; fail_count: number } | undefined;
    if (!row) return { success: 0, fail: 0, rate: 0 };
    const total = row.success_count + row.fail_count;
    return { success: row.success_count, fail: row.fail_count, rate: total > 0 ? row.success_count / total : 0 };
  }

  private rowToSkill(row: SkillRow): Skill {
    return {
      id: row.id,
      intentEmbedding: row.intent_embedding,
      procedure: JSON.parse(row.procedure_json) as Record<string, unknown>,
      successCount: row.success_count,
      failCount: row.fail_count,
      lastUsed: row.last_used,
      createdAt: row.created_at,
    };
  }

  private rowToCausal(row: CausalRow): CausalEdge {
    return {
      id: row.id,
      causeRef: row.cause_ref,
      effectRef: row.effect_ref,
      strength: row.strength,
      evidenceCount: row.evidence_count,
      createdAt: row.created_at,
    };
  }
}
