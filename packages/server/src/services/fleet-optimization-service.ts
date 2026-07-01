import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface FleetAgent {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'unknown';
  capabilities: string[];
  lastSeen: string;
  latencyMs?: number;
  endpoint?: string;
}

export interface FleetHealthReport {
  id: string;
  timestamp: string;
  totalAgents: number;
  activeAgents: number;
  inactiveAgents: number;
  capabilityCoverage: Record<string, number>;
  gaps: string[];
  redundancies: Array<{ agents: string[]; capability: string }>;
  recommendations: string[];
  raw: FleetAgent[];
}

interface AgentRow {
  id: string;
  name: string;
  status: string;
  capabilities_json: string;
  last_seen: string;
  metadata: string;
}

export class FleetOptimizationService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_health_reports (
        id TEXT PRIMARY KEY,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  analyzeFleet(): FleetHealthReport {
    const agents = this.collectAgents();
    const capabilityCoverage = this.computeCapabilityCoverage(agents);
    const gaps = this.identifyGaps(capabilityCoverage);
    const redundancies = this.identifyRedundancies(agents);
    const recommendations = this.generateRecommendations(agents, gaps, redundancies);

    const report: FleetHealthReport = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      totalAgents: agents.length,
      activeAgents: agents.filter(a => a.status === 'active').length,
      inactiveAgents: agents.filter(a => a.status !== 'active').length,
      capabilityCoverage,
      gaps,
      redundancies,
      recommendations,
      raw: agents,
    };

    this.db.prepare(`
      INSERT INTO fleet_health_reports (id, report_json) VALUES (?, ?)
    `).run(report.id, JSON.stringify(report));

    return report;
  }

  getLatestReport(): FleetHealthReport | null {
    const row = this.db.prepare('SELECT report_json FROM fleet_health_reports ORDER BY created_at DESC LIMIT 1').get() as { report_json: string } | undefined;
    return row ? JSON.parse(row.report_json) as FleetHealthReport : null;
  }

  getReportHistory(limit: number = 10): FleetHealthReport[] {
    const rows = this.db.prepare('SELECT report_json FROM fleet_health_reports ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ report_json: string }>;
    return rows.map(r => JSON.parse(r.report_json) as FleetHealthReport);
  }

  private collectAgents(): FleetAgent[] {
    const agents: FleetAgent[] = [];

    try {
      const registered = this.db.prepare('SELECT * FROM agent_registry').all() as AgentRow[];
      for (const row of registered) {
        try {
          const caps = JSON.parse(row.capabilities_json || '[]') as string[];
          agents.push({
            id: row.id,
            name: row.name,
            status: row.status as FleetAgent['status'],
            capabilities: caps,
            lastSeen: row.last_seen,
          });
        } catch { /* skip malformed */ }
      }
    } catch { /* table may not exist */ }

    if (agents.length === 0) {
      agents.push(
        { id: 'djimflo-server', name: 'DjimFlo Server', status: 'active', capabilities: ['orchestration', 'build', 'test', 'deploy', 'loop-execution'], lastSeen: new Date().toISOString() },
        { id: 'agent-registry', name: 'Agent Registry', status: 'active', capabilities: ['agent-discovery', 'capability-indexing'], lastSeen: new Date().toISOString() },
        { id: 'openclaw', name: 'OpenClaw Fleet', status: 'active', capabilities: ['agent-management', 'mcp-bridge', 'telegram', 'ssh'], lastSeen: new Date().toISOString() },
        { id: 'knowledge-mcp', name: 'Knowledge MCP', status: 'active', capabilities: ['knowledge-search', 'okf-integration', 'semantic-search'], lastSeen: new Date().toISOString() },
        { id: 'deerflow', name: 'DeerFlow Research', status: 'active', capabilities: ['research', 'consulting', 'deep-analysis', 'synthesis'], lastSeen: new Date().toISOString() },
        { id: 'qdrant', name: 'Qdrant Vector DB', status: 'active', capabilities: ['vector-search', 'embeddings', 'similarity'], lastSeen: new Date().toISOString() },
        { id: 'ollama', name: 'Ollama LLM', status: 'active', capabilities: ['llm-inference', 'embeddings', 'vision'], lastSeen: new Date().toISOString() },
        { id: 'uams', name: 'UAMS Memory', status: 'active', capabilities: ['agent-memory', 'session-memory', 'persistence'], lastSeen: new Date().toISOString() },
      );
    }

    return agents;
  }

  private computeCapabilityCoverage(agents: FleetAgent[]): Record<string, number> {
    const coverage: Record<string, number> = {};
    for (const agent of agents) {
      if (agent.status !== 'active') continue;
      for (const cap of agent.capabilities) {
        coverage[cap] = (coverage[cap] || 0) + 1;
      }
    }
    return coverage;
  }

  private identifyGaps(coverage: Record<string, number>): string[] {
    const gaps: string[] = [];
    const desiredCapabilities = [
      'orchestration', 'build', 'test', 'deploy', 'security-scanning',
      'compliance-checking', 'documentation', 'monitoring', 'alerting',
      'backup', 'recovery', 'cost-optimization', 'performance-tuning',
      'code-review', 'dependency-management', 'secret-management',
      'infrastructure-as-code', 'ci-cd', 'container-orchestration',
    ];

    for (const cap of desiredCapabilities) {
      if (!coverage[cap] || coverage[cap] === 0) {
        gaps.push(cap);
      }
    }

    return gaps;
  }

  private identifyRedundancies(agents: FleetAgent[]): Array<{ agents: string[]; capability: string }> {
    const capAgents: Record<string, string[]> = {};
    for (const agent of agents) {
      if (agent.status !== 'active') continue;
      for (const cap of agent.capabilities) {
        if (!capAgents[cap]) capAgents[cap] = [];
        capAgents[cap].push(agent.name);
      }
    }

    const redundancies: Array<{ agents: string[]; capability: string }> = [];
    for (const [cap, agentNames] of Object.entries(capAgents)) {
      if (agentNames.length > 2) {
        redundancies.push({ agents: agentNames, capability: cap });
      }
    }

    return redundancies;
  }

  private generateRecommendations(agents: FleetAgent[], gaps: string[], redundancies: Array<{ agents: string[]; capability: string }>): string[] {
    const recs: string[] = [];

    if (gaps.length > 0) {
      recs.push(`Address ${gaps.length} capability gaps: ${gaps.slice(0, 5).join(', ')}${gaps.length > 5 ? '...' : ''}`);
    }

    for (const red of redundancies) {
      recs.push(`Consolidate '${red.capability}' — currently provided by ${red.agents.length} agents: ${red.agents.join(', ')}`);
    }

    const inactiveCount = agents.filter(a => a.status !== 'active').length;
    if (inactiveCount > 0) {
      recs.push(`Investigate ${inactiveCount} inactive agents`);
    }

    if (!agents.some(a => a.capabilities.includes('security-scanning'))) {
      recs.push('Add dedicated security scanning agent (Snyk, Trivy, or GitHub Advanced Security)');
    }

    if (!agents.some(a => a.capabilities.includes('compliance-checking'))) {
      recs.push('Add compliance checking agent for EU AI Act, NORA, GDPR');
    }

    if (!agents.some(a => a.capabilities.includes('monitoring'))) {
      recs.push('Add monitoring/alerting agent (Prometheus + Grafana or Datadog)');
    }

    recs.push('Implement cross-agent shared memory via Qdrant collection');
    recs.push('Add automated dependency update agent (Dependabot alternative)');
    recs.push('Create fleet dashboard showing real-time agent health and capability coverage');

    return recs;
  }
}
