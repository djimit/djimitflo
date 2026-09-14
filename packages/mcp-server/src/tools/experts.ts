/**
 * Read-only Frontier Expert Intelligence tools (§35): search, get, capabilities, claims.
 * Resolution and council dispatch stay on the governed HTTP routes (/api/swarms/expert/*).
 * Tentative states are returned verbatim; nothing here presents inferred expertise as verified.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DbHandle } from '../db.js';

type Row = Record<string, unknown>;
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const missing = (what: string) => ({ content: [{ type: 'text' as const, text: what }], isError: true });

function ready(dbHandle: DbHandle): boolean {
  return Boolean(dbHandle.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'expert_identities'").get());
}
function all(dbHandle: DbHandle, sql: string, ...params: unknown[]): Row[] { return dbHandle.db.prepare(sql).all(...params) as Row[]; }
function one(dbHandle: DbHandle, sql: string, ...params: unknown[]): Row | undefined { return dbHandle.db.prepare(sql).get(...params) as Row | undefined; }
const NOT_READY = 'Frontier expert tables are not present in this database (run server migrations).';

export function registerExpertTools(server: McpServer, dbHandle: DbHandle): void {
  server.registerTool(
    'djimitflo_expert_search',
    {
      description: 'Search frontier expert identities by name fragment, capability id and lifecycle state. States other than ACTIVE are tentative (DISCOVERED = a signature only, never expertise).',
      inputSchema: {
        name: z.string().optional().describe('Case-insensitive name fragment'),
        capability: z.string().optional().describe('Capability id, e.g. mechanistic_interpretability'),
        state: z.string().optional().describe('Lifecycle state, e.g. ACTIVE, CAPABILITY_INFERRED, DISCOVERED'),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 25)'),
      },
    },
    async ({ name, capability, state, limit }) => {
      if (!ready(dbHandle)) return missing(NOT_READY);
      const rows = all(dbHandle, `SELECT DISTINCT e.id, e.canonical_name, e.lifecycle_state, e.identity_confidence, e.version, e.updated_at,
          (SELECT json_group_array(capability_id) FROM expert_capabilities c WHERE c.expert_id = e.id AND c.status != 'revoked') AS capabilities_json
        FROM expert_identities e
        ${capability ? "JOIN expert_capabilities k ON k.expert_id = e.id AND k.status != 'revoked' AND k.capability_id = @capability" : ''}
        WHERE (@state IS NULL OR e.lifecycle_state = @state) AND (@name IS NULL OR e.canonical_name LIKE @name COLLATE NOCASE)
        ORDER BY e.updated_at DESC LIMIT @limit`, { capability: capability ?? null, state: state ?? null, name: name ? `%${name}%` : null, limit: limit ?? 25 });
      return text({ count: rows.length, experts: rows.map((row) => ({ ...row, capabilities: JSON.parse(String(row.capabilities_json || '[]')), capabilities_json: undefined })) });
    },
  );

  server.registerTool(
    'djimitflo_expert_get',
    {
      description: 'Full provenance for one expert: identity, capabilities with their evidence items, affiliations, claims, lifecycle events and version history.',
      inputSchema: { expertId: z.string().describe('Expert id (expert:<uuid>)') },
    },
    async ({ expertId }) => {
      if (!ready(dbHandle)) return missing(NOT_READY);
      const expert = one(dbHandle, 'SELECT * FROM expert_identities WHERE id = ?', expertId);
      if (!expert) return missing(`Expert not found: ${expertId}`);
      const capabilities = all(dbHandle, "SELECT capability_id, status, confidence, evidence_refs_json, derived_by, updated_at FROM expert_capabilities WHERE expert_id = ? AND status != 'revoked'", expertId)
        .map((capability) => ({ ...capability, evidence: all(dbHandle, 'SELECT id, kind, tier, title, url, source_family, lifecycle, retrieved_at FROM expert_evidence WHERE id IN (SELECT value FROM json_each(?))', String(capability.evidence_refs_json)) }));
      return text({
        expert, capabilities,
        evidence: all(dbHandle, 'SELECT id, kind, tier, title, url, source_family, lifecycle, retrieved_at FROM expert_evidence WHERE expert_id = ? ORDER BY tier, retrieved_at DESC', expertId),
        affiliations: all(dbHandle, 'SELECT organization, role, valid_from, valid_to, confidence, source_ref FROM expert_affiliations WHERE expert_id = ?', expertId),
        claims: all(dbHandle, 'SELECT id, subject, relation, object, polarity, conditions, scope, evidence_refs_json, confidence, criticality, support_status, created_at FROM expert_claims WHERE expert_id = ? ORDER BY created_at DESC LIMIT 100', expertId),
        lifecycle: all(dbHandle, 'SELECT from_state, to_state, actor, reason, created_at FROM expert_lifecycle_events WHERE expert_id = ? ORDER BY created_at', expertId),
        versions: all(dbHandle, 'SELECT version, change_summary, created_at FROM expert_versions WHERE expert_id = ? ORDER BY version', expertId),
      });
    },
  );

  server.registerTool(
    'djimitflo_expert_capabilities',
    { description: 'The capability taxonomy (ids, labels, parents, aliases) with the number of ACTIVE experts per capability.', inputSchema: {} },
    async () => {
      if (!ready(dbHandle)) return missing(NOT_READY);
      return text(all(dbHandle, `SELECT t.id, t.label, t.parent_id, t.aliases_json,
        (SELECT COUNT(*) FROM expert_capabilities c JOIN expert_identities e ON e.id = c.expert_id WHERE c.capability_id = t.id AND c.status != 'revoked' AND e.lifecycle_state = 'ACTIVE') AS active_experts
        FROM expert_capability_taxonomy t ORDER BY t.id`).map((row) => ({ ...row, aliases: JSON.parse(String(row.aliases_json || '[]')), aliases_json: undefined })));
    },
  );

  server.registerTool(
    'djimitflo_expert_claims',
    {
      description: 'Claims (with evidence refs) matching a proposition fragment, plus their SUPPORTS/CONTRADICTS/QUALIFIES relations. Disagreements are returned as-is, never averaged.',
      inputSchema: { query: z.string().describe('Fragment of subject, relation or object'), limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ query, limit }) => {
      if (!ready(dbHandle)) return missing(NOT_READY);
      const like = `%${query}%`;
      const claims = all(dbHandle, `SELECT c.id, c.expert_id, e.canonical_name, c.subject, c.relation, c.object, c.polarity, c.evidence_refs_json, c.confidence, c.criticality, c.support_status
        FROM expert_claims c JOIN expert_identities e ON e.id = c.expert_id
        WHERE c.subject LIKE ? COLLATE NOCASE OR c.relation LIKE ? COLLATE NOCASE OR c.object LIKE ? COLLATE NOCASE ORDER BY c.created_at DESC LIMIT ?`, like, like, like, limit ?? 50);
      const ids = JSON.stringify(claims.map((claim) => claim.id));
      const relations = all(dbHandle, 'SELECT id, from_claim_id, to_claim_id, relation, rationale, resolved_at FROM expert_claim_relations WHERE from_claim_id IN (SELECT value FROM json_each(?)) OR to_claim_id IN (SELECT value FROM json_each(?))', ids, ids);
      return text({ claims, relations, unresolved_contradictions: relations.filter((relation) => relation.relation === 'CONTRADICTS' && !relation.resolved_at).length });
    },
  );
}
