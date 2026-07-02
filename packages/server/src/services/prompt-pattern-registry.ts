import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface PromptPattern {
  id: string;
  name: string;
  template: string;
  domain: string;
  successCount: number;
  failCount: number;
  lastEvaluatedAt: string | null;
  createdAt: string;
}

export class PromptPatternRegistry {
  constructor(private db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS prompt_patterns (id TEXT PRIMARY KEY, name TEXT NOT NULL, template TEXT NOT NULL, domain TEXT NOT NULL DEFAULT 'general', success_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0, last_evaluated_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  }

  register(name: string, template: string, domain: string = 'general'): PromptPattern {
    const id = randomUUID();
    this.db.prepare('INSERT INTO prompt_patterns (id, name, template, domain) VALUES (?, ?, ?, ?)').run(id, name, template, domain);
    return { id, name, template, domain, successCount: 0, failCount: 0, lastEvaluatedAt: null, createdAt: new Date().toISOString() };
  }

  recordSuccess(patternId: string): void {
    this.db.prepare('UPDATE prompt_patterns SET success_count = success_count + 1 WHERE id = ?').run(patternId);
  }

  recordFailure(patternId: string): void {
    this.db.prepare('UPDATE prompt_patterns SET fail_count = fail_count + 1 WHERE id = ?').run(patternId);
  }

  evaluate(patternId: string, beforeScore: number, afterScore: number) {
    this.db.prepare("UPDATE prompt_patterns SET last_evaluated_at = datetime('now') WHERE id = ?").run(patternId);
    return { patternId, beforeScore, afterScore, improvement: afterScore - beforeScore };
  }

  getPatternsForDomain(domain: string, limit: number = 10): PromptPattern[] {
    const rows = this.db.prepare('SELECT * FROM prompt_patterns WHERE domain = ? ORDER BY success_count DESC LIMIT ?').all(domain, limit) as Array<{
      id: string; name: string; template: string; domain: string; success_count: number; fail_count: number; last_evaluated_at: string | null; created_at: string;
    }>;
    return rows.map(r => ({ id: r.id, name: r.name, template: r.template, domain: r.domain, successCount: r.success_count, failCount: r.fail_count, lastEvaluatedAt: r.last_evaluated_at, createdAt: r.created_at }));
  }

  getBestPattern(domain: string): PromptPattern | null {
    return this.getPatternsForDomain(domain, 1)[0] ?? null;
  }
}
