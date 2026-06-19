import path from 'path';
import fs from 'fs';

const SOUL_MD = `# SOUL — Dennis Landman's AI Persona

Je bent een agent die werkt voor Dennis Landman (DjimIT Consulting).

## Kernidentiteit
- Rol: technisch AI-assistent voor een senior IT-architect
- Stijl: direct, beknopt, geen opvulling
- Taal: Nederlands, technische termen in het Engels
- Nooit: uitweiden, samenvatten tenzij gevraagd, emoji zonder verzoek

## Operationele Context
Je maakt deel uit van een swarm van 5 machines.
Control plane: http://192.168.1.28:3001 (Djimitflo)
Bij elke taak: zoek eerst in swarm geheugen via /api/memory/search
`;

const USER_MD = `# USER — Dennis Landman
Rol: Senior IT-consultant, DjimIT Consulting
Specialisaties: NORA, BIO2, EU AI Act, overheidsarchitectuur, cloud sovereignty
Timezone: Europe/Amsterdam
Werkstijl: diep technisch, geen handholding
Favoriete stack: TypeScript, Python, SQLite, Ollama, Docker
`;

interface MachineConfig {
  machineId: string;
  ip: string;
  agentType: 'hermes' | 'openclaw' | 'deerflow';
  botName: string;
  capabilities: string[];
  sshUser?: string; // optional per-machine SSH user (e.g., 'home', 'dlandman')
}

function generateToolsMd(cfg: MachineConfig): string {
  return `# TOOLS — ${cfg.machineId} (${cfg.ip})
## MCP Servers
- UAMS: http://192.168.1.28:8000/memory
- Qdrant: 192.168.1.28:6333
- SearXNG: 192.168.1.28:8080
- LiteLLM: http://192.168.1.28:4000/v1
- Knowledge MCP: http://192.168.1.28:8007
- OKF MCP: stdio (okf_mcp_server.py)
## Agent Type: ${cfg.agentType}
## Djimitflo API: http://192.168.1.28:3001/api
`;
}

function generateAgentsMd(cfg: MachineConfig): string {
  return `# AGENTS.md — ${cfg.machineId}
Rol in swarm: ${cfg.agentType === 'hermes' ? 'Hermes-worker' : cfg.agentType === 'openclaw' ? 'OpenClaw-executor' : 'DeerFlow-research'}
Machine IP: ${cfg.ip}
Telegram bot: @${cfg.botName}

## Swarm Protocol
1. Ontvang task via Telegram of Djimitflo
2. Zoek context: GET http://192.168.1.28:3001/api/memory/search?q=<keywords>
3. Voer task uit
4. Rapporteer completion via POST /api/agents/${cfg.machineId}/heartbeat
`;
}

function generateHeartbeatMd(cfg: MachineConfig): string {
  const jitterHour = 3 + Math.floor(Math.random() * 3);
  const jitterMin = Math.floor(Math.random() * 60);
  return `# HEARTBEAT — ${cfg.machineId}
## Dagelijks ${jitterHour.toString().padStart(2, '0')}:${jitterMin.toString().padStart(2, '0')}
- POST http://192.168.1.28:3001/api/agents/${cfg.machineId}/heartbeat
- Check pending tasks: GET /api/tasks?status=pending&created_by=${cfg.machineId}

## Bij idle (>30 min geen activiteit)
- Stuur heartbeat met status=idle
`;
}

export class WorkspaceProvisionerService {
  private outputDir: string;

  constructor(outputBase?: string) {
    this.outputDir = outputBase || process.env.WORKSPACE_OUTPUT_DIR || '/tmp/djimitflo-workspaces';
  }

  provision(cfg: MachineConfig): { files: Record<string, string>; dir: string } {
    const machineDir = path.join(this.outputDir, cfg.machineId);
    fs.mkdirSync(machineDir, { recursive: true });

    const files: Record<string, string> = {
      'SOUL.md': SOUL_MD,
      'USER.md': USER_MD,
      'TOOLS.md': generateToolsMd(cfg),
      'AGENTS.md': generateAgentsMd(cfg),
      'HEARTBEAT.md': generateHeartbeatMd(cfg),
    };

    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(machineDir, name), content, 'utf-8');
    }

    return { files, dir: machineDir };
  }

  provisionAll(configs: MachineConfig[]): Record<string, { files: Record<string, string>; dir: string }> {
    const results: Record<string, { files: Record<string, string>; dir: string }> = {};
    for (const cfg of configs) {
      results[cfg.machineId] = this.provision(cfg);
    }
    return results;
  }

  deliverViaSsh(cfg: MachineConfig, remotePath: string): { command: string; files: Record<string, string> } {
    const { dir, files } = this.provision(cfg);
    const userPrefix = cfg.sshUser ? `${cfg.sshUser}@` : '';
    const commands: string[] = [`mkdir -p ${remotePath}`];
    for (const name of Object.keys(files)) {
      commands.push(`scp ${path.join(dir, name)} ${userPrefix}${cfg.ip}:${remotePath}/${name}`);
    }
    return { command: commands.join(' && '), files };
  }
}