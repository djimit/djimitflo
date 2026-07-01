import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface AutobiographicalEvent {
  id: string;
  type: 'learning' | 'achievement' | 'failure' | 'discovery' | 'change';
  title: string;
  description: string;
  significance: number;
  context: Record<string, unknown>;
  createdAt: string;
}

interface EventRow {
  id: string;
  type: string;
  title: string;
  description: string;
  significance: number;
  context_json: string;
  created_at: string;
}

export class AutobiographicalMemoryService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autobiographical_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        significance REAL NOT NULL DEFAULT 0.5,
        context_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_autobio_type ON autobiographical_events(type)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_autobio_significance ON autobiographical_events(significance DESC)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_autobio_created ON autobiographical_events(created_at DESC)');
  }

  recordEvent(event: Omit<AutobiographicalEvent, 'id' | 'createdAt'>): AutobiographicalEvent {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO autobiographical_events (id, type, title, description, significance, context_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, event.type, event.title, event.description, event.significance, JSON.stringify(event.context));
    return { ...event, id, createdAt: now };
  }

  getEvents(type?: string, limit: number = 20): AutobiographicalEvent[] {
    const rows = type
      ? this.db.prepare('SELECT * FROM autobiographical_events WHERE type = ? ORDER BY created_at DESC LIMIT ?').all(type, limit) as EventRow[]
      : this.db.prepare('SELECT * FROM autobiographical_events ORDER BY created_at DESC LIMIT ?').all(limit) as EventRow[];
    return rows.map(this.rowToEvent);
  }

  getSignificantEvents(threshold: number = 0.7, limit: number = 10): AutobiographicalEvent[] {
    const rows = this.db.prepare('SELECT * FROM autobiographical_events WHERE significance >= ? ORDER BY significance DESC LIMIT ?').all(threshold, limit) as EventRow[];
    return rows.map(this.rowToEvent);
  }

  generateNarrative(): string {
    const events = this.getEvents(undefined, 50);
    if (events.length === 0) return 'No experiences recorded yet.';

    const learnings = events.filter(e => e.type === 'learning');
    const achievements = events.filter(e => e.type === 'achievement');
    const failures = events.filter(e => e.type === 'failure');
    const discoveries = events.filter(e => e.type === 'discovery');

    const parts: string[] = [];
    parts.push(`I have accumulated ${events.length} experiences.`);

    if (achievements.length > 0) {
      parts.push(`I have achieved ${achievements.length} significant outcomes, including: ${achievements.slice(0, 3).map(a => a.title).join(', ')}.`);
    }
    if (learnings.length > 0) {
      parts.push(`I have learned ${learnings.length} lessons from my experiences.`);
    }
    if (failures.length > 0) {
      parts.push(`I have encountered ${failures.length} failures that taught me valuable lessons.`);
    }
    if (discoveries.length > 0) {
      parts.push(`I have made ${discoveries.length} discoveries that expanded my capabilities.`);
    }

    return parts.join(' ');
  }

  getTimeline(): AutobiographicalEvent[] {
    const rows = this.db.prepare('SELECT * FROM autobiographical_events ORDER BY created_at ASC').all() as EventRow[];
    return rows.map(this.rowToEvent);
  }

  searchEvents(query: string, limit: number = 10): AutobiographicalEvent[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      'SELECT * FROM autobiographical_events WHERE title LIKE ? OR description LIKE ? ORDER BY created_at DESC LIMIT ?'
    ).all(pattern, pattern, limit) as EventRow[];
    return rows.map(this.rowToEvent);
  }

  getEventCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM autobiographical_events').get() as { c: number };
    return row.c;
  }

  private rowToEvent(row: EventRow): AutobiographicalEvent {
    return {
      id: row.id,
      type: row.type as AutobiographicalEvent['type'],
      title: row.title,
      description: row.description,
      significance: row.significance,
      context: JSON.parse(row.context_json) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }
}
