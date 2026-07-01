import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface SharedSkill {
  id: string;
  name: string;
  version: string;
  procedure: Record<string, unknown>;
  authorInstance: string;
  rating: number;
  ratingCount: number;
  installCount: number;
  publishedAt: string;
}

interface SkillShareRow {
  id: string;
  skill_id: string;
  name: string;
  version: string;
  procedure_json: string;
  author_instance: string;
  rating: number;
  rating_count: number;
  install_count: number;
  published_at: string;
}

export class SkillMarketplaceService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_shares (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        procedure_json TEXT NOT NULL,
        author_instance TEXT NOT NULL,
        rating REAL DEFAULT 0,
        rating_count INTEGER DEFAULT 0,
        install_count INTEGER DEFAULT 0,
        published_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_skill_shares_name ON skill_shares(name)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_skill_shares_rating ON skill_shares(rating DESC)');
  }

  publishSkill(skillId: string, name: string, version: string, procedure: Record<string, unknown>): SharedSkill {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO skill_shares (id, skill_id, name, version, procedure_json, author_instance, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, skillId, name, version, JSON.stringify(procedure), 'local-instance', now);

    return { id, name, version, procedure, authorInstance: 'local-instance', rating: 0, ratingCount: 0, installCount: 0, publishedAt: now };
  }

  searchSkills(intent: string, limit: number = 10): SharedSkill[] {
    const pattern = `%${intent}%`;
    const rows = this.db.prepare(
      'SELECT * FROM skill_shares WHERE name LIKE ? OR procedure_json LIKE ? ORDER BY rating DESC, install_count DESC LIMIT ?'
    ).all(pattern, pattern, limit) as SkillShareRow[];
    return rows.map(this.rowToShared);
  }

  installSkill(sharedSkillId: string): void {
    this.db.prepare('UPDATE skill_shares SET install_count = install_count + 1 WHERE id = ?').run(sharedSkillId);
  }

  rateSkill(skillId: string, rating: number): void {
    const clamped = Math.max(0, Math.min(5, rating));
    const skill = this.db.prepare('SELECT rating, rating_count FROM skill_shares WHERE id = ?').get(skillId) as { rating: number; rating_count: number } | undefined;
    if (!skill) return;

    const newRating = (skill.rating * skill.rating_count + clamped) / (skill.rating_count + 1);
    this.db.prepare('UPDATE skill_shares SET rating = ?, rating_count = rating_count + 1 WHERE id = ?').run(newRating, skillId);
  }

  getTrendingSkills(limit: number = 10): SharedSkill[] {
    const rows = this.db.prepare('SELECT * FROM skill_shares ORDER BY install_count DESC, rating DESC LIMIT ?').all(limit) as SkillShareRow[];
    return rows.map(this.rowToShared);
  }

  getSharedSkill(skillId: string): SharedSkill | null {
    const row = this.db.prepare('SELECT * FROM skill_shares WHERE id = ?').get(skillId) as SkillShareRow | undefined;
    return row ? this.rowToShared(row) : null;
  }

  getAllShared(limit: number = 50): SharedSkill[] {
    const rows = this.db.prepare('SELECT * FROM skill_shares ORDER BY published_at DESC LIMIT ?').all(limit) as SkillShareRow[];
    return rows.map(this.rowToShared);
  }

  unpublishSkill(skillId: string): void {
    this.db.prepare('DELETE FROM skill_shares WHERE id = ?').run(skillId);
  }

  private rowToShared(row: SkillShareRow): SharedSkill {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      procedure: JSON.parse(row.procedure_json) as Record<string, unknown>,
      authorInstance: row.author_instance,
      rating: row.rating,
      ratingCount: row.rating_count,
      installCount: row.install_count,
      publishedAt: row.published_at,
    };
  }
}
