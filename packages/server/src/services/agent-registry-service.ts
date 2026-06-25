import path from 'path';
import fs from 'fs';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';

export interface AgentConcept {
  id: string;
  name: string;
  description: string;
  machineIp: string;
  agentType: string;
  hostMachineId: string;
  capabilities: string[];
  lastSeen: string;
  status: string;
  metadata?: Record<string, unknown>;
}

function sanitizeForFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

function frontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map(String).join(', ')}]`;
      if (typeof v === 'object') return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${String(v)}`;
    });
  return `---\n${lines.join('\n')}\n---`;
}

export class AgentRegistryService {
  private okfAgentsDir: string;

  constructor(okfBase?: string) {
    this.okfAgentsDir = path.join(okfBase || KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true }), 'agents');
  }

  ensureDir(): void {
    fs.mkdirSync(this.okfAgentsDir, { recursive: true });
  }

  writeAgentConcept(agent: AgentConcept): string {
    this.ensureDir();
    const slug = sanitizeForFilename(agent.hostMachineId || agent.name);
    const filePath = path.join(this.okfAgentsDir, `${slug}.md`);
    const tags = [agent.agentType, slug, ...(agent.capabilities?.slice(0, 3) ?? [])];
    const front = frontmatter({
      type: 'Agent',
      title: agent.name,
      description: agent.description?.slice(0, 200) || '',
      resource: `http://${agent.machineIp}:3001`,
      tags,
      timestamp: agent.lastSeen,
      status: agent.status,
      capabilities: agent.capabilities,
      metadata: agent.metadata,
    });
    const body = [
      `# ${agent.name}`,
      '',
      `**Machine**: ${agent.machineIp}`,
      `**Agent type**: ${agent.agentType}`,
      `**Status**: ${agent.status}`,
      `**Last seen**: ${agent.lastSeen}`,
      '',
      '## Capabilities',
      '',
      ...(agent.capabilities?.length ? agent.capabilities.map((c) => `- ${c}`) : ['- _none registered_']),
      '',
    ].join('\n');

    const content = `${front}\n\n${body}\n`;
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  regenerateIndex(agents: AgentConcept[]): string {
    this.ensureDir();
    const indexPath = path.join(this.okfAgentsDir, 'index.md');
    const grouped = agents.reduce<Record<string, AgentConcept[]>>((acc, a) => {
      const t = a.agentType || 'unknown';
      if (!acc[t]) acc[t] = [];
      acc[t].push(a);
      return acc;
    }, {});

    const lines = ['# Agents', ''];
    for (const [type, list] of Object.entries(grouped)) {
      lines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)}`);
      lines.push('');
      for (const a of list) {
        const slug = sanitizeForFilename(a.hostMachineId || a.name);
        lines.push(`* [${a.name}](${slug}.md) — ${a.status} (last seen: ${a.lastSeen})`);
      }
      lines.push('');
    }

    const content = lines.join('\n');
    fs.writeFileSync(indexPath, content, 'utf8');
    return indexPath;
  }

  updateHeartbeat(agent: AgentConcept): { conceptPath: string; indexPath: string } {
    const conceptPath = this.writeAgentConcept(agent);
    const agents = this.readExistingAgents();
    const deduped = new Map<string, AgentConcept>();
    for (const a of agents) deduped.set(sanitizeForFilename(a.hostMachineId || a.name), a);
    deduped.set(sanitizeForFilename(agent.hostMachineId || agent.name), agent);
    const indexPath = this.regenerateIndex(Array.from(deduped.values()));
    return { conceptPath, indexPath };
  }

  private readExistingAgents(): AgentConcept[] {
    const files = fs.readdirSync(this.okfAgentsDir).filter((f) => f.endsWith('.md') && f !== 'index.md');
    const agents: AgentConcept[] = [];
    for (const f of files) {
      const raw = fs.readFileSync(path.join(this.okfAgentsDir, f), 'utf8');
      const fm = parseFrontmatter(raw);
      if (fm) {
        const slug = f.replace('.md', '');
        agents.push({
          id: (fm.id as string) || slug,
          name: (fm.title as string) || slug,
          description: (fm.description as string) || '',
          machineIp: ((fm.resource as string) || '').replace(/^http:\/\//, '').replace(/:3001$/, ''),
          agentType: Array.isArray(fm.tags) ? (fm.tags[0] as string) : 'unknown',
          hostMachineId: slug,
          capabilities: Array.isArray(fm.capabilities) ? (fm.capabilities as string[]) : [],
          lastSeen: (fm.timestamp as string) || '',
          status: (fm.status as string) || 'unknown',
        });
      }
    }
    return agents;
  }
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const lines = match[1].split('\n');
  const result: Record<string, unknown> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (val.startsWith('[')) {
      result[key] = val.replace(/[\[\]]/g, '').split(',').map((s) => s.trim());
    } else if (val.startsWith('{')) {
      try { result[key] = JSON.parse(val); } catch { result[key] = val; }
    } else {
      result[key] = val;
    }
  }
  return result;
}
