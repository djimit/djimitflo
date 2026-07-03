import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';

let db: Database.Database;
let knowledge: KnowledgeRuntimeService;
let intel: SwarmIntelligenceService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  knowledge = new KnowledgeRuntimeService(db);
  intel = new SwarmIntelligenceService(db);
});

afterEach(() => {
  db?.close();
});

describe('G15.1 security boundary', () => {
  it('rejects OKF paths outside canonical root', () => {
    // A path outside the canonical OKF root should be rejected
    expect(KnowledgeRuntimeService.isWithinOkfRoot('/etc/passwd')).toBe(false);
    expect(KnowledgeRuntimeService.isWithinOkfRoot('/tmp/../etc/passwd')).toBe(false);
    expect(KnowledgeRuntimeService.isWithinOkfRoot('/nonexistent/path')).toBe(false);
  });

  it('throws on OKF path escape', () => {
    expect(() => KnowledgeRuntimeService.validateOkfPath('/etc/passwd')).toThrow(/OKF_PATH_ESCAPE/);
  });

  it('resolves evidence refs and verifies existence', () => {
    // Create a capability to test evidence ref resolution
    const cap = intel.registerCapability({
      id: 'test-cap-for-ref',
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

    // Resolve an existing capability ref
    const resolved = knowledge.resolveEvidenceRef(`capability:${cap.id}`);
    expect(resolved.kind).toBe('capability');
    expect(resolved.exists).toBe(true);
    expect(resolved.valid).toBe(true);

    // Resolve a non-existing ref
    const missing = knowledge.resolveEvidenceRef('capability:nonexistent-id');
    expect(missing.exists).toBe(false);
    expect(missing.valid).toBe(true);

    // Resolve an invalid kind
    const invalid = knowledge.resolveEvidenceRef('unknown:xxx');
    expect(invalid.valid).toBe(false);
  });

  it('rejects secret-like payloads across all intelligence endpoints', () => {
    // Capability with secret
    expect(() => intel.registerCapability({
      id: 'secret-cap',
      kind: 'skill',
      owner: 'test',
      version: '1.0.0',
      status: 'draft',
      risk_ceiling: 'low',
      input_schema_ref: 'none',
      output_schema_ref: 'none',
      allowed_actions: ['maker:mock'],
      forbidden_actions: ['deploy'],
      required_evidence: ['worker_lease'],
      eval_threshold: 0.75,
      removal_strategy: 'disable',
      metadata: { secret: 'bearer fakelongtokennotreal12345' },
    })).toThrow(/SECRET_DETECTED/);

    // Claim with secret
    expect(() => intel.createClaim({
      claim: 'The secret is: bearer fakebearertokennotreal1234567',
      claim_type: 'observation',
      subject_ref: 'test',
      confidence: 0.5,
      status: 'proposed',
      created_from: 'test',
    })).toThrow(/SECRET_DETECTED/);

    // Evidence edge with secret
    expect(() => intel.createEvidenceEdge('source:ok', 'target:ok', 'test', { token: 'bearer fakebearertokennotreal1234' }))
      .toThrow(/SECRET_DETECTED/);
  });

  it('uses scoped permissions for governance and runner manifest endpoints', () => {
    // Verify the route file has scoped permissions
    const fs = require('fs');
    const routeContent = fs.readFileSync(path.resolve(__dirname, '../routes/swarms.ts'), 'utf8');
    expect(routeContent).toContain('write:capability');
    expect(routeContent).toContain('write:claim');
    expect(routeContent).toContain('write:governance');
    expect(routeContent).toContain('write:runner_manifest');
    expect(routeContent).toContain('read:evidence');
    // write:swarm_action should still exist for general actions but not for capabilities/claims/governance
    expect(routeContent).toContain('write:swarm_action');
  });
});
