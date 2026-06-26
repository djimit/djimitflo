import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export type OpenCodeMcpStatus = 'ok' | 'locked' | 'unconfigured' | 'unavailable' | 'error';

export interface OpenCodeMcpEntry {
  name: string;
  status: OpenCodeMcpStatus;
  detail: string;
  remediation: string | null;
}

export interface OpenCodeConfigHealth {
  config_path: string;
  config_exists: boolean;
  missing_sections: string[];
  mcp_entries: OpenCodeMcpEntry[];
  skill_candidates: string[];
  per_agent_recommendations: string[];
  credential_redacted: boolean;
}

export class OpenCodeHealthService {
  /**
   * G16.3: Inspect OpenCode config (opencode.jsonc) and report health.
   * Detects missing sections, classifies MCP status, scans skills.
   */
  inspectConfig(configPath?: string): OpenCodeConfigHealth {
    const resolvedPath = configPath || this.findConfigPath();
    const exists = fs.existsSync(resolvedPath);

    if (!exists) {
      return {
        config_path: resolvedPath,
        config_exists: false,
        missing_sections: ['mcp', 'tools', 'agent', 'permission.skill'],
        mcp_entries: [],
        skill_candidates: [],
        per_agent_recommendations: ['Create opencode.jsonc with required sections'],
        credential_redacted: true,
      };
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const config = this.parseJsonc(content);

    const requiredSections = ['mcp', 'tools', 'agent', 'permission'];
    const missingSections = requiredSections.filter((section) => !config[section]);

    const mcpEntries = this.classifyMcpEntries(config);
    const skillCandidates = this.scanSkills(config);
    const perAgentRecs = this.perAgentRecommendations(config, mcpEntries);

    return {
      config_path: resolvedPath,
      config_exists: true,
      missing_sections: missingSections,
      mcp_entries: mcpEntries,
      skill_candidates: skillCandidates,
      per_agent_recommendations: perAgentRecs,
      credential_redacted: true,
    };
  }

  private findConfigPath(): string {
    const candidates = [
      path.join(process.cwd(), 'opencode.jsonc'),
      path.join(process.cwd(), 'opencode.json'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return candidates[0];
  }

  private parseJsonc(content: string): Record<string, unknown> {
    // Try plain JSON first (handles URLs with // correctly)
    try {
      return JSON.parse(content);
    } catch {
      // Fall back to JSONC: strip comments and trailing commas
      // But preserve // inside strings (e.g. URLs)
      const cleaned = content
        .replace(/"(?:[^"\\]|\\.)*"/g, (match) => match.replace(/\//g, '\u200B\u200B'))
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/\u200B\u200B/g, '//');
      try {
        return JSON.parse(cleaned);
      } catch {
        return {};
      }
    }
  }

  private classifyMcpEntries(config: Record<string, unknown>): OpenCodeMcpEntry[] {
    const mcpConfig = config.mcp as Record<string, unknown> | undefined;
    if (!mcpConfig || typeof mcpConfig !== 'object') return [];

    // Try running `opencode mcp list` with timeout
    let cliOutput: string | null = null;
    try {
      cliOutput = execFileSync('opencode', ['mcp', 'list'], {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (error: any) {
      // Classify the error
      const stderr = error.stderr || error.message || '';
      if (stderr.includes('database is locked') || stderr.includes('SQLITE_BUSY')) {
        return Object.keys(mcpConfig).map((name) => ({
          name,
          status: 'locked' as OpenCodeMcpStatus,
          detail: 'OpenCode database is locked',
          remediation: 'Close other OpenCode instances or wait for the lock to release. Do not delete state automatically.',
        }));
      }
      if (stderr.includes('not found') || stderr.includes('ENOENT')) {
        return Object.keys(mcpConfig).map((name) => ({
          name,
          status: 'unavailable' as OpenCodeMcpStatus,
          detail: 'opencode binary not found',
          remediation: 'Install OpenCode CLI to enable MCP health checks',
        }));
      }
    }

    const entries: OpenCodeMcpEntry[] = [];
    for (const [name, _value] of Object.entries(mcpConfig)) {
      if (cliOutput && cliOutput.toLowerCase().includes(name.toLowerCase())) {
        entries.push({
          name,
          status: 'ok',
          detail: 'MCP server registered and detected by opencode mcp list',
          remediation: null,
        });
      } else {
        entries.push({
          name,
          status: 'unconfigured',
          detail: 'MCP server in config but not detected by opencode mcp list',
          remediation: 'Run opencode mcp list to verify the server is registered',
        });
      }
    }
    return entries;
  }

  private scanSkills(config: Record<string, unknown>): string[] {
    // Try both flat key "permission.skill" and nested "permission" -> "skill"
    let skills = config['permission.skill'] as Record<string, unknown> | undefined;
    if (!skills && config.permission && typeof config.permission === 'object') {
      skills = (config.permission as Record<string, unknown>).skill as Record<string, unknown> | undefined;
    }
    if (!skills || typeof skills !== 'object') return [];
    // List skill names as capability candidates (without activating them)
    return Object.keys(skills).map((name) => `skill:${name}`);
  }

  private perAgentRecommendations(config: Record<string, unknown>, mcpEntries: OpenCodeMcpEntry[]): string[] {
    const recs: string[] = [];
    const agentConfig = config.agent as Record<string, unknown> | undefined;

    if (!agentConfig) {
      recs.push('Configure per-agent MCP exposure instead of global heavy MCP enablement');
    }

    const lockedCount = mcpEntries.filter((e) => e.status === 'locked').length;
    if (lockedCount > 0) {
      recs.push(`${lockedCount} MCP server(s) have locked database — close other instances or wait`);
    }

    const unconfiguredCount = mcpEntries.filter((e) => e.status === 'unconfigured').length;
    if (unconfiguredCount > 0) {
      recs.push(`${unconfiguredCount} MCP server(s) in config but not detected — verify registration`);
    }

    return recs;
  }
}
