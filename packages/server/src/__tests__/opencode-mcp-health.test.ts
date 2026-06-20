import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeMcpHealthService } from '../services/opencode-mcp-health-service';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-health-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function writeConfig(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('OpenCodeMcpHealthService.inspectConfig', () => {
  it('returns all false when config is absent', () => {
    const svc = new OpenCodeMcpHealthService();
    const h = svc.inspectConfig(path.join(tmpDir, 'missing.jsonc'));
    expect(h.has_mcp).toBe(false);
    expect(h.has_tools).toBe(false);
  });

  it('detects mcp, tools, agent, permission.skill', () => {
    const p = writeConfig('opencode.jsonc', JSON.stringify({
      mcp: { myserver: { command: 'npx', args: ['myserver'] } },
      tools: {},
      agent: 'build',
      permission: { skill: 'auto' },
    }));
    const h = new OpenCodeMcpHealthService().inspectConfig(p);
    expect(h.has_mcp).toBe(true);
    expect(h.has_tools).toBe(true);
    expect(h.has_agent).toBe(true);
    expect(h.has_permission_skill).toBe(true);
  });

  it('recommends per-agent scoping for heavy MCP servers', () => {
    const p = writeConfig('opencode.jsonc', JSON.stringify({
      mcp: { filesystem: {}, shell: {} },
    }));
    const h = new OpenCodeMcpHealthService().inspectConfig(p);
    expect(h.per_agent_recommendations.length).toBeGreaterThan(0);
    expect(h.per_agent_recommendations[0]).toMatch(/per-agent/i);
  });

  it('handles JSONC with line comments', () => {
    const p = writeConfig('opencode.jsonc', `{
  // this is a comment
  "mcp": { "s1": {} } // trailing
}`);
    const h = new OpenCodeMcpHealthService().inspectConfig(p);
    expect(h.has_mcp).toBe(true);
  });
});

describe('OpenCodeMcpHealthService.probeMcpList', () => {
  it('returns locked when binary emits "database is locked"', () => {
    const bin = path.join(tmpDir, 'opencode-locked');
    fs.writeFileSync(bin, '#!/usr/bin/env sh\necho "database is locked" >&2\nexit 1\n');
    fs.chmodSync(bin, 0o755);
    const result = new OpenCodeMcpHealthService(bin).probeMcpList(3000);
    expect(result.status).toBe('locked');
    expect(result.remediation).toMatch(/Stop/);
  });

  it('returns unavailable when binary is missing', () => {
    const result = new OpenCodeMcpHealthService('/no/such/binary').probeMcpList(1000);
    expect(result.status).toBe('unavailable');
  });

  it('returns ok with server list on success', () => {
    const bin = path.join(tmpDir, 'opencode-ok');
    fs.writeFileSync(bin, '#!/usr/bin/env sh\necho "myserver  My MCP server"\nexit 0\n');
    fs.chmodSync(bin, 0o755);
    const result = new OpenCodeMcpHealthService(bin).probeMcpList(3000);
    expect(result.status).toBe('ok');
    expect(result.servers).toContain('myserver');
  });

  it('returns unconfigured when no servers listed', () => {
    const bin = path.join(tmpDir, 'opencode-empty');
    fs.writeFileSync(bin, '#!/usr/bin/env sh\necho ""\nexit 0\n');
    fs.chmodSync(bin, 0o755);
    const result = new OpenCodeMcpHealthService(bin).probeMcpList(3000);
    expect(result.status).toBe('unconfigured');
  });
});

describe('OpenCodeMcpHealthService.scanSkillPermissions', () => {
  it('produces capability candidates from permission.skill config', () => {
    const p = writeConfig('opencode.jsonc', JSON.stringify({
      permission: { skill: { 'my-skill': 'auto', 'gated-skill': 'ask' } },
    }));
    const candidates = new OpenCodeMcpHealthService().scanSkillPermissions(p);
    expect(candidates).toHaveLength(2);
    expect(candidates.find((c) => c.name === 'gated-skill')?.gated).toBe(true);
    expect(candidates.find((c) => c.name === 'my-skill')?.gated).toBe(false);
  });

  it('does not activate skills — returns descriptors only', () => {
    const p = writeConfig('opencode.jsonc', JSON.stringify({ permission: { skill: { 's': 'auto' } } }));
    // If activation happened, something external would run; we just assert the return shape
    const candidates = new OpenCodeMcpHealthService().scanSkillPermissions(p);
    expect(candidates?.every((c) => c.kind === 'opencode_skill')).toBe(true);
  });
});
