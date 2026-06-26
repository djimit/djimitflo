import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { OpenCodeHealthService } from '../services/opencode-health-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;
let intel: SwarmIntelligenceService;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  intel = new SwarmIntelligenceService(db);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g16-test-'));
});

afterEach(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('G16.3 OpenCode health inspector', () => {
  it('reports missing config when opencode.jsonc does not exist', () => {
    const health = new OpenCodeHealthService();
    const result = health.inspectConfig(path.join(tempDir, 'nonexistent.jsonc'));

    expect(result.config_exists).toBe(false);
    expect(result.missing_sections).toContain('mcp');
    expect(result.missing_sections).toContain('tools');
    expect(result.missing_sections).toContain('agent');
    expect(result.per_agent_recommendations.length).toBeGreaterThan(0);
  });

  it('detects missing sections in an existing config', () => {
    const configPath = path.join(tempDir, 'opencode.jsonc');
    fs.writeFileSync(configPath, JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      instructions: ['AGENTS.md'],
    }));

    const health = new OpenCodeHealthService();
    const result = health.inspectConfig(configPath);

    expect(result.config_exists).toBe(true);
    expect(result.missing_sections).toContain('mcp');
    expect(result.missing_sections).toContain('tools');
  });

  it('scans skills as capability candidates without activating them', () => {
    const configPath = path.join(tempDir, 'opencode.jsonc');
    fs.writeFileSync(configPath, JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      permission: {
        skill: {
          'code-review': { enabled: true },
          'commit-commands': { enabled: false },
        },
      },
    }));

    const health = new OpenCodeHealthService();
    const result = health.inspectConfig(configPath);

    console.error('DEBUG skill_candidates:', JSON.stringify(result.skill_candidates)); console.error('DEBUG missing:', JSON.stringify(result.missing_sections)); expect(result.skill_candidates).toContain('skill:code-review');
    expect(result.skill_candidates).toContain('skill:commit-commands');
  });

  it('redacts credential values in output', () => {
    const configPath = path.join(tempDir, 'opencode.jsonc');
    fs.writeFileSync(configPath, JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
    }));

    const health = new OpenCodeHealthService();
    const result = health.inspectConfig(configPath);

    expect(result.credential_redacted).toBe(true);
  });
});

describe('G16.4 OpenAI capability descriptors', () => {
  it('registers OpenAI Agents SDK as a privileged candidate that cannot route', () => {
    const cap = intel.registerCapability({
      id: 'openai-agents-test',
      kind: 'openai_agents_sdk' as any,
      owner: 'test',
      version: '1.0.0',
      status: 'validated',
      risk_ceiling: 'low',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['research'],
      forbidden_actions: ['deploy'],
      required_evidence: ['adapter_proof'],
      eval_threshold: 0.5,
      removal_strategy: 'disable if adapter not proven',
    });

    // Even as 'validated', OpenAI descriptors cannot route local workers
    expect(cap.live_route_allowed).toBe(false);
    expect(cap.blocked_reasons).toContain('OPENAI_DESCRIPTOR_REQUIRES_ADAPTER_PROOF');
  });

  it('registers OpenAI MCP connector as privileged candidate', () => {
    const cap = intel.registerCapability({
      id: 'openai-mcp-test',
      kind: 'openai_mcp_connector' as any,
      owner: 'test',
      version: '1.0.0',
      status: 'validated',
      risk_ceiling: 'medium',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['read'],
      forbidden_actions: ['deploy'],
      required_evidence: ['authorization_ref'],
      eval_threshold: 0.5,
      removal_strategy: 'disable if authorization missing',
    });

    expect(cap.live_route_allowed).toBe(false);
    expect(cap.blocked_reasons).toContain('OPENAI_DESCRIPTOR_REQUIRES_ADAPTER_PROOF');
  });

  it('local skills still route when validated (OpenAI descriptors do not block local kinds)', () => {
    const cap = intel.registerCapability({
      id: 'local-skill-test',
      kind: 'skill',
      owner: 'test',
      version: '1.0.0',
      status: 'validated',
      risk_ceiling: 'low',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'],
      required_evidence: ['worker_lease'],
      eval_threshold: 0.5,
      removal_strategy: 'disable',
    });
    db.prepare('UPDATE swarm_capabilities SET eval_score = 0.9 WHERE id = ?').run('local-skill-test');
    const updated = intel.getCapability('local-skill-test');
    expect(updated.live_route_allowed).toBe(true);
    expect(updated.blocked_reasons).not.toContain('OPENAI_DESCRIPTOR_REQUIRES_ADAPTER_PROOF');
  });
});
