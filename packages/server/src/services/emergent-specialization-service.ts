import type { Database } from 'better-sqlite3';

export interface SpecializationRecord {
  agentId: string;
  domain: string;
  subDomain: string;
  nRuns: number;
  successRate: number;
  status: 'emerging' | 'established' | 'pruned';
  lastActivity: string;
}

export class EmergentSpecializationService {
  constructor(private db: Database) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_specializations (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, domain TEXT NOT NULL,
      sub_domain TEXT NOT NULL DEFAULT '', n_runs INTEGER NOT NULL DEFAULT 0,
      success_rate REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'emerging',
      last_activity TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, domain, sub_domain)
    )`);
  }

  recordPerformance(agentId: string, domain: string, subDomain: string, success: boolean): void {
    const existing = this.db.prepare('SELECT n_runs, success_rate FROM agent_specializations WHERE agent_id = ? AND domain = ? AND sub_domain = ?').get(agentId, domain, subDomain) as { n_runs: number; success_rate: number } | undefined;

    const newRuns = (existing?.n_runs ?? 0) + 1;
    const existingSuccesses = existing ? Math.round(existing.success_rate * existing.n_runs) : 0;
    const newSuccessRate = (existingSuccesses + (success ? 1 : 0)) / newRuns;

    let status: SpecializationRecord['status'] = 'emerging';
    if (newRuns >= 3 && newSuccessRate >= 0.8) status = 'established';
    else if (newRuns >= 5 && newSuccessRate < 0.2) status = 'pruned';

    this.db.prepare("INSERT OR REPLACE INTO agent_specializations (id, agent_id, domain, sub_domain, n_runs, success_rate, status, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))").run(`${agentId}-${domain}-${subDomain}`, agentId, domain, subDomain, newRuns, newSuccessRate, status);
  }

  getSpecializations(agentId?: string, status?: string): SpecializationRecord[] {
    let query = 'SELECT * FROM agent_specializations WHERE 1=1';
    const params: unknown[] = [];
    if (agentId) { query += ' AND agent_id = ?'; params.push(agentId); }
    if (status) { query += ' AND status = ?'; params.push(status); }
    query += ' ORDER BY success_rate DESC, n_runs DESC';
    const rows = this.db.prepare(query).all(...params) as Array<{ agent_id: string; domain: string; sub_domain: string; n_runs: number; success_rate: number; status: string; last_activity: string; }>;
    return rows.map(r => ({ agentId: r.agent_id, domain: r.domain, subDomain: r.sub_domain, nRuns: r.n_runs, successRate: r.success_rate, status: r.status as SpecializationRecord['status'], lastActivity: r.last_activity }));
  }

  getEstablishedSpecializations(): SpecializationRecord[] {
    return this.getSpecializations(undefined, 'established');
  }

  getRecommendation(agentId: string, domain: string): string {
    const specs = this.getSpecializations(agentId, 'established');
    const domainSpec = specs.find(s => s.domain === domain);

    if (domainSpec) return `Use agent ${agentId} for ${domain} (success rate: ${(domainSpec.successRate * 100).toFixed(0)}%)`;

    const crossDomain = this.detectCrossDomainTransfer();
    const related = crossDomain.find(t => t.from === domain || t.to === domain);
    if (related) return `Domain ${domain} has transfer potential with ${related.from === domain ? related.to : related.from}`;

    return `No established specialization for ${domain} - use general agent`;
  }

  detectCrossDomainTransfer(): Array<{ from: string; to: string; confidence: number }> {
    const established = this.getEstablishedSpecializations();
    const transfers: Array<{ from: string; to: string; confidence: number }> = [];
    const domainAgents = new Map<string, Set<string>>();

    for (const spec of established) {
      if (!domainAgents.has(spec.domain)) domainAgents.set(spec.domain, new Set());
      domainAgents.get(spec.domain)!.add(spec.agentId);
    }

    const domains = [...domainAgents.keys()];
    for (let i = 0; i < domains.length; i++) {
      for (let j = i + 1; j < domains.length; j++) {
        const a = domainAgents.get(domains[i])!;
        const b = domainAgents.get(domains[j])!;
        const shared = [...a].filter(x => b.has(x));
        if (shared.length > 0) {
          transfers.push({ from: domains[i], to: domains[j], confidence: shared.length / Math.min(a.size, b.size) });
        }
      }
    }

    return transfers;
  }
}
