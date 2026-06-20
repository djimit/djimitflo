// OpenCode MCP and skills health inspector (G16.3).
// Detects config gaps, MCP database lock, and skill permissions without
// persisting credential values. Never invokes mutating MCP tools.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type McpStatus = 'ok' | 'locked' | 'unconfigured' | 'unavailable' | 'error';

export interface McpHealthResult {
  status: McpStatus;
  reason: string;
  remediation?: string;
  servers?: string[];
  capability_candidates?: { name: string; kind: string; gated: boolean }[];
}

export interface OpenCodeConfigHealth {
  has_mcp: boolean;
  has_tools: boolean;
  has_agent: boolean;
  has_permission_skill: boolean;
  per_agent_recommendations: string[];
}

function outputToString(output: string | Buffer | null | undefined): string {
  if (!output) return '';
  return typeof output === 'string' ? output : output.toString('utf8');
}

export class OpenCodeMcpHealthService {
  constructor(private readonly opencodeBin: string = process.env.OPENCODE_BIN_PATH || 'opencode') {}

  inspectConfig(configPath: string): OpenCodeConfigHealth {
    const health: OpenCodeConfigHealth = {
      has_mcp: false, has_tools: false, has_agent: false, has_permission_skill: false,
      per_agent_recommendations: [],
    };
    if (!fs.existsSync(configPath)) return health;
    let raw: string;
    try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return health; }
    // Strip JSON5/JSONC comments before parsing
    const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    let config: Record<string, unknown>;
    try { config = JSON.parse(stripped); } catch { return health; }
    health.has_mcp = 'mcp' in config && config.mcp !== null && typeof config.mcp === 'object';
    health.has_tools = 'tools' in config;
    health.has_agent = 'agent' in config;
    health.has_permission_skill = typeof (config as any)?.permission?.skill === 'string';
    if (health.has_mcp) {
      const mcpServers = Object.keys((config.mcp as Record<string, unknown>) || {});
      // Heavy/sensitive MCP servers warrant per-agent scope rather than global enable
      const heavy = mcpServers.filter((s) => /filesystem|shell|exec|terminal|docker|ssh|db|database/i.test(s));
      if (heavy.length > 0) {
        health.per_agent_recommendations.push(
          `Enable ${heavy.join(', ')} per-agent only — global heavy MCP enablement increases attack surface`,
        );
      }
    }
    return health;
  }

  probeMcpList(timeoutMs = 5000): McpHealthResult {
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(this.opencodeBin, ['mcp', 'list'], {
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 512 * 1024,
      });
    } catch {
      return { status: 'unavailable', reason: 'opencode binary not found or spawn failed' };
    }
    if (result.error) {
      return { status: 'unavailable', reason: `spawn error: ${result.error.message}` };
    }
    const stdout = outputToString(result.stdout);
    const stderr = outputToString(result.stderr);
    const combined = stdout + stderr;
    if (/database is locked/i.test(combined)) {
      return {
        status: 'locked',
        reason: 'OpenCode MCP database is locked by another process',
        remediation: 'Stop other OpenCode sessions; do not delete database files automatically',
      };
    }
    if (result.status !== 0) {
      if (/not found|no such|command not found/i.test(combined)) {
        return { status: 'unavailable', reason: 'opencode binary not found' };
      }
      return { status: 'error', reason: `opencode mcp list exited ${result.status}: ${combined.slice(0, 200)}` };
    }
    // Parse server names (one per line, "  name  description" format)
    const servers = stdout.split('\n')
      .map((line: string) => line.trim().split(/\s+/)[0])
      .filter((server: string) => server && !server.startsWith('#'));
    if (servers.length === 0) {
      return { status: 'unconfigured', reason: 'no MCP servers listed', servers: [] };
    }
    return { status: 'ok', reason: 'MCP servers listed', servers };
  }

  scanSkillPermissions(configPath: string): McpHealthResult['capability_candidates'] {
    // Reads skill permission config and produces capability candidates without activating skills.
    if (!fs.existsSync(configPath)) return [];
    let raw: string;
    try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return []; }
    const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    let config: Record<string, unknown>;
    try { config = JSON.parse(stripped); } catch { return []; }
    const skillPerm = (config as any)?.permission?.skill;
    if (!skillPerm || typeof skillPerm !== 'object') return [];
    return Object.entries(skillPerm as Record<string, unknown>).map(([name, gated]) => ({
      name, kind: 'opencode_skill', gated: gated === 'ask' || gated === false,
    }));
  }

  findConfigs(searchRoots: string[]): string[] {
    const candidates: string[] = [];
    for (const root of searchRoots) {
      for (const name of ['opencode.jsonc', 'opencode.json', '.opencode.jsonc', '.opencode.json']) {
        const p = path.join(root, name);
        if (fs.existsSync(p)) candidates.push(p);
      }
    }
    return candidates;
  }
}
