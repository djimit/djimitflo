import type { Database } from 'better-sqlite3';

export interface CrossDomainQuery {
  sourceDomain: string;
  targetDomain: string;
  intervention: Record<string, string>;
  predictedOutcome: string;
  confidence: number;
}

interface DomainEdgeRow {
  source_domain: string;
  target_domain: string;
  relation: string;
  strength: number;
}

export class UnifiedWorldModelService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS domain_relations (
        id TEXT PRIMARY KEY,
        source_domain TEXT NOT NULL,
        target_domain TEXT NOT NULL,
        relation TEXT NOT NULL,
        strength REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  learnDomainRelation(source: string, target: string, relation: string, strength: number): void {
    const existing = this.db.prepare(
      'SELECT id FROM domain_relations WHERE source_domain = ? AND target_domain = ? AND relation = ?'
    ).get(source, target, relation) as { id: string } | undefined;

    if (existing) {
      this.db.prepare('UPDATE domain_relations SET strength = ? WHERE id = ?').run(strength, existing.id);
    } else {
      const id = `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.db.prepare(
        'INSERT INTO domain_relations (id, source_domain, target_domain, relation, strength) VALUES (?, ?, ?, ?, ?)'
      ).run(id, source, target, relation, strength);
    }
  }

  crossDomainQuery(source: string, target: string, intervention: Record<string, string>): CrossDomainQuery {
    const relations = this.db.prepare(
      'SELECT * FROM domain_relations WHERE source_domain = ? AND target_domain = ?'
    ).all(source, target) as DomainEdgeRow[];

    let totalStrength = 0;
    let count = 0;

    for (const rel of relations) {
      totalStrength += rel.strength;
      count++;
    }

    const avgStrength = count > 0 ? totalStrength / count : 0.1;

    return {
      sourceDomain: source,
      targetDomain: target,
      intervention,
      predictedOutcome: avgStrength > 0.5 ? 'positive' : 'neutral',
      confidence: Math.min(0.9, avgStrength),
    };
  }

  getDomainRelations(domain: string): DomainEdgeRow[] {
    const rows = this.db.prepare(
      "SELECT source_domain, target_domain, relation, strength FROM domain_relations WHERE source_domain = ? OR target_domain = ? ORDER BY strength DESC"
    ).all(domain, domain) as DomainEdgeRow[];
    return rows;
  }

  getAllDomains(): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT source_domain as domain FROM domain_relations UNION SELECT DISTINCT target_domain FROM domain_relations'
    ).all() as Array<{ domain: string }>;
    return rows.map(r => r.domain);
  }
}
