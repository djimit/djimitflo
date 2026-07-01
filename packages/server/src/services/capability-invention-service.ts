import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface InventionProposal {
  id: string;
  name: string;
  description: string;
  componentCapabilities: string[];
  evidence: number;
  avgSuccessRate: number;
  status: 'proposed' | 'evaluating' | 'accepted' | 'rejected';
  createdAt: string;
}

interface InventionRow {
  id: string;
  name: string;
  description: string;
  component_capabilities_json: string;
  evidence: number;
  avg_success_rate: number;
  status: string;
  created_at: string;
}

interface LeasePattern {
  capabilities: string[];
  success: boolean;
  runtime: string;
}

export class CapabilityInventionService {
  private minEvidence = 3;
  private minSuccessRate = 0.6;

  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capability_inventions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        component_capabilities_json TEXT NOT NULL,
        evidence INTEGER NOT NULL DEFAULT 0,
        avg_success_rate REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_invention_status ON capability_inventions(status)');
  }

  analyzeTrajectories(): InventionProposal[] {
    const leases = this.db.prepare(`
      SELECT wl.capability_id, wl.status, wl.runtime, lr.id as run_id
      FROM worker_leases wl
      JOIN loop_runs lr ON wl.loop_run_id = lr.id
      WHERE wl.role = 'maker'
      ORDER BY lr.created_at DESC
      LIMIT 200
    `).all() as Array<{ capability_id: string; status: string; runtime: string; run_id: string }>;

    const runGroups = new Map<string, LeasePattern[]>();
    for (const lease of leases) {
      if (!lease.capability_id) continue;
      if (!runGroups.has(lease.run_id)) runGroups.set(lease.run_id, []);
      runGroups.get(lease.run_id)!.push({
        capabilities: [lease.capability_id],
        success: lease.status === 'completed',
        runtime: lease.runtime,
      });
    }

    const comboCounts = new Map<string, { count: number; successes: number; capabilities: string[] }>();

    for (const [, patterns] of runGroups) {
      const successful = patterns.filter(p => p.success);
      if (successful.length < 2) continue;

      const caps = [...new Set(successful.flatMap(p => p.capabilities))].sort();
      if (caps.length < 2) continue;

      const key = caps.join('+');
      const existing = comboCounts.get(key) || { count: 0, successes: 0, capabilities: caps };
      existing.count++;
      existing.successes++;
      comboCounts.set(key, existing);
    }

    const proposals: InventionProposal[] = [];

    for (const [key, data] of comboCounts) {
      if (data.count < this.minEvidence) continue;
      const avgSuccess = data.successes / data.count;
      if (avgSuccess < this.minSuccessRate) continue;

      const existing = this.db.prepare('SELECT id FROM capability_inventions WHERE name = ?').get(key) as { id: string } | undefined;

      if (!existing) {
        const id = randomUUID();
        this.db.prepare(`
          INSERT INTO capability_inventions (id, name, description, component_capabilities_json, evidence, avg_success_rate, status)
          VALUES (?, ?, ?, ?, ?, ?, 'proposed')
        `).run(id, key, `Composed capability from ${data.capabilities.join(', ')}`, JSON.stringify(data.capabilities), data.count, avgSuccess);

        proposals.push({
          id,
          name: key,
          description: `Composed capability from ${data.capabilities.join(', ')}`,
          componentCapabilities: data.capabilities,
          evidence: data.count,
          avgSuccessRate: avgSuccess,
          status: 'proposed',
          createdAt: new Date().toISOString(),
        });
      }
    }

    return proposals;
  }

  getProposedInventions(): InventionProposal[] {
    const rows = this.db.prepare("SELECT * FROM capability_inventions WHERE status = 'proposed' ORDER BY avg_success_rate DESC").all() as InventionRow[];
    return rows.map(this.rowToProposal);
  }

  acceptInvention(inventionId: string): void {
    const invention = this.db.prepare('SELECT * FROM capability_inventions WHERE id = ?').get(inventionId) as InventionRow | undefined;
    if (!invention) return;

    const caps = JSON.parse(invention.component_capabilities_json) as string[];
    this.db.prepare(`
      INSERT OR IGNORE INTO swarm_capabilities (id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
        allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score, eval_threshold,
        cost_model_json, removal_strategy, metadata, created_at, updated_at)
      VALUES (?, 'skill', 'invention', '1.0.0', 'candidate', 'low', 'none', 'none',
        '["spawn_runtime_worker"]', '["deploy"]', '["proof:test"]', ?, 0.5, '{}', 'demote_on_fail',
        ?, datetime('now'), datetime('now'))
    `).run(invention.name, invention.avg_success_rate, JSON.stringify({ invented: true, components: caps }));

    this.db.prepare("UPDATE capability_inventions SET status = 'accepted' WHERE id = ?").run(inventionId);
  }

  rejectInvention(inventionId: string): void {
    this.db.prepare("UPDATE capability_inventions SET status = 'rejected' WHERE id = ?").run(inventionId);
  }

  private rowToProposal(row: InventionRow): InventionProposal {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      componentCapabilities: JSON.parse(row.component_capabilities_json) as string[],
      evidence: row.evidence,
      avgSuccessRate: row.avg_success_rate,
      status: row.status as InventionProposal['status'],
      createdAt: row.created_at,
    };
  }
}
