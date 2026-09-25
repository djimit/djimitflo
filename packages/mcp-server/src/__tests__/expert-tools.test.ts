import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import type { DbHandle } from '../db.js';
import { registerExpertTools } from '../tools/experts.js';

const TABLES = `
  CREATE TABLE expert_capability_taxonomy (id TEXT PRIMARY KEY, label TEXT, description TEXT, parent_id TEXT, aliases_json TEXT DEFAULT '[]');
  CREATE TABLE expert_identities (id TEXT PRIMARY KEY, canonical_name TEXT, aliases_json TEXT DEFAULT '[]', lifecycle_state TEXT, identity_confidence REAL DEFAULT 0, provenance_json TEXT DEFAULT '{}', version INTEGER DEFAULT 1, created_at TEXT DEFAULT '2026-01-01', updated_at TEXT DEFAULT '2026-01-01');
  CREATE TABLE expert_evidence (id TEXT PRIMARY KEY, expert_id TEXT, kind TEXT, tier INTEGER, title TEXT, url TEXT, source_family TEXT, lifecycle TEXT DEFAULT 'active', retrieved_at TEXT DEFAULT '2026-01-01');
  CREATE TABLE expert_capabilities (id TEXT PRIMARY KEY, expert_id TEXT, capability_id TEXT, confidence REAL, evidence_refs_json TEXT, derived_by TEXT, status TEXT DEFAULT 'inferred', updated_at TEXT DEFAULT '2026-01-01');
  CREATE TABLE expert_affiliations (id TEXT PRIMARY KEY, expert_id TEXT, organization TEXT, role TEXT, valid_from TEXT, valid_to TEXT, source_ref TEXT, confidence REAL);
  CREATE TABLE expert_claims (id TEXT PRIMARY KEY, expert_id TEXT, subject TEXT, relation TEXT, object TEXT, polarity TEXT, conditions TEXT, scope TEXT, evidence_refs_json TEXT, confidence REAL, criticality TEXT, support_status TEXT, created_at TEXT DEFAULT '2026-01-01');
  CREATE TABLE expert_claim_relations (id TEXT PRIMARY KEY, from_claim_id TEXT, to_claim_id TEXT, relation TEXT, rationale TEXT, resolved_at TEXT);
  CREATE TABLE expert_lifecycle_events (id TEXT PRIMARY KEY, expert_id TEXT, from_state TEXT, to_state TEXT, actor TEXT, reason TEXT, created_at TEXT DEFAULT '2026-01-01');
  CREATE TABLE expert_versions (id TEXT PRIMARY KEY, expert_id TEXT, version INTEGER, snapshot_json TEXT, change_summary TEXT, created_at TEXT DEFAULT '2026-01-01');
  INSERT INTO expert_capability_taxonomy VALUES ('mechanistic_interpretability', 'Mechanistic interpretability', '', NULL, '["circuits"]');
  INSERT INTO expert_identities (id, canonical_name, lifecycle_state, identity_confidence) VALUES ('expert:a', 'Interp Person', 'ACTIVE', 0.9), ('expert:s', 'Signer Only', 'DISCOVERED', 0);
  INSERT INTO expert_evidence VALUES ('evidence:1', 'expert:a', 'paper', 1, 'Circuits paper', 'https://arxiv.org/abs/1', 'arxiv.org', 'active', '2026-01-01');
  INSERT INTO expert_capabilities VALUES ('cap:1', 'expert:a', 'mechanistic_interpretability', 0.9, '["evidence:1"]', 'test', 'approved', '2026-01-01');
  INSERT INTO expert_claims (id, expert_id, subject, relation, object, polarity, evidence_refs_json, confidence, criticality, support_status) VALUES
    ('claim:1', 'expert:a', 'circuits', 'explain', 'induction heads', 'asserts', '["evidence:1"]', 0.8, 'normal', 'open'),
    ('claim:2', 'expert:a', 'circuits', 'explain', 'induction heads', 'denies', '["evidence:1"]', 0.6, 'critical', 'open');
  INSERT INTO expert_claim_relations VALUES ('rel:1', 'claim:1', 'claim:2', 'CONTRADICTS', 'fixture', NULL);
  INSERT INTO expert_lifecycle_events (id, expert_id, from_state, to_state, actor, reason) VALUES ('ev:1', 'expert:a', 'APPROVED', 'ACTIVE', 'human', 'ok');
`;

describe('frontier expert MCP tools (read-only, §35)', () => {
  let handle: DbHandle;
  let tools: Record<string, { handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>;

  beforeEach(() => {
    const db = new Database(':memory:');
    handle = { db, close: () => db.close() } as unknown as DbHandle;
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerExpertTools(server, handle);
    tools = (server as any)._registeredTools;
  });
  afterEach(() => handle.close());

  it('reports missing tables instead of guessing', async () => {
    const result = await tools.djimitflo_expert_search.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not present');
  });

  it('searches, gets provenance, lists capabilities and returns contradictions verbatim', async () => {
    handle.db.exec(TABLES);
    const search = JSON.parse((await tools.djimitflo_expert_search.handler({ capability: 'mechanistic_interpretability', state: 'ACTIVE' })).content[0].text);
    expect(search.count).toBe(1);
    expect(search.experts[0]).toMatchObject({ id: 'expert:a', capabilities: ['mechanistic_interpretability'] });
    const signer = JSON.parse((await tools.djimitflo_expert_search.handler({ name: 'signer' })).content[0].text);
    expect(signer.experts[0].lifecycle_state).toBe('DISCOVERED');

    const detail = JSON.parse((await tools.djimitflo_expert_get.handler({ expertId: 'expert:a' })).content[0].text);
    expect(detail.capabilities[0].evidence[0]).toMatchObject({ id: 'evidence:1', tier: 1 });
    expect(detail.lifecycle[0].to_state).toBe('ACTIVE');
    expect((await tools.djimitflo_expert_get.handler({ expertId: 'expert:x' })).isError).toBe(true);

    const taxonomy = JSON.parse((await tools.djimitflo_expert_capabilities.handler({})).content[0].text);
    expect(taxonomy[0]).toMatchObject({ id: 'mechanistic_interpretability', aliases: ['circuits'], active_experts: 1 });

    const claims = JSON.parse((await tools.djimitflo_expert_claims.handler({ query: 'induction' })).content[0].text);
    expect(claims.claims).toHaveLength(2);
    expect(claims.unresolved_contradictions).toBe(1);
  });
});
