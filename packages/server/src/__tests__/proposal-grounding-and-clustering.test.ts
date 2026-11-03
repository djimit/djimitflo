import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SelfImprovementService } from '../services/self-improvement-service';
import { ProposalClusteringService } from '../services/proposal-clustering-service';

describe('proposal grounding gate', () => {
  let db: Database.Database;
  let svc: SelfImprovementService;
  const prev = process.env.PROPOSAL_GROUNDING_REQUIRED;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    svc = new SelfImprovementService(db);
  });
  afterEach(() => { db.close(); if (prev === undefined) delete process.env.PROPOSAL_GROUNDING_REQUIRED; else process.env.PROPOSAL_GROUNDING_REQUIRED = prev; });

  const reflect = (description: string, withEvidence = true) => svc.generateFromReflection({
    whatFailed: [], lessonsLearned: ['lesson'], proposedImprovements: [description], ...(withEvidence ? { reflectionId: 'r1' } : {}),
  }, true)[0];

  it('is inert by default: an ungrounded reflection still gets a panel', () => {
    const p = reflect('Improve the telemetry story');
    expect(p.status).toBe('proposed');
    expect(p.panelId).toBeTruthy();
  });

  it('parks ungrounded reflection proposals as needs_grounding, with no panel, when required', () => {
    process.env.PROPOSAL_GROUNDING_REQUIRED = 'true';
    const p = reflect('Improve the telemetry story');
    expect(p.status).toBe('needs_grounding');
    expect(p.panelId).toBeNull();
    expect(reflect('Improve the telemetry story').id).toBe(p.id); // deduped, not re-created every cycle
  });

  it('lets a proposal through when it names a repo path and has evidence, recording the grounding', () => {
    process.env.PROPOSAL_GROUNDING_REQUIRED = 'true';
    const p = reflect('Add retry backoff in packages/server/src/services/loop-daemon.ts');
    expect(p.status).toBe('proposed');
    const row = db.prepare('SELECT grounding_json FROM self_improvements WHERE id = ?').get(p.id) as { grounding_json: string };
    expect(JSON.parse(row.grounding_json)).toMatchObject({ target: 'packages/server/src/services/loop-daemon.ts', derived: true });
  });

  it('does not gate grounded sources (build errors)', () => {
    process.env.PROPOSAL_GROUNDING_REQUIRED = 'true';
    const [p] = svc.generateFromBuildErrors(['vitest failed in some suite']);
    expect(p.source).toBe('feedback');
    expect(p.status).toBe('proposed');
  });
});

describe('ProposalClusteringService', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  const park = (id: string, title: string, description: string, priority = 0.5) => {
    db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, fingerprint, created_at, updated_at) VALUES (?, 'feature', ?, ?, 'r', 'reflection', 'needs_more_evidence', ?, ?, datetime('now'), datetime('now'))")
      .run(id, title, description, priority, `fp-${id}`);
  };

  it('archives near-duplicates behind one representative, reversibly, and survives migration', async () => {
    park('a', 'Add telemetry API', 'Add a telemetry api endpoint for runtime metrics collection', 0.9);
    park('b', 'Add telemetry API endpoint', 'Add a telemetry api endpoint for runtime metrics collection now', 0.5);
    park('c', 'Rewrite scheduler', 'Completely different topic about scheduler fairness and starvation', 0.5);
    const svc = new ProposalClusteringService(db);
    const plan = await svc.plan();
    expect(plan.method).toBe('jaccard');
    expect(plan.clusters).toHaveLength(1);
    expect(plan.clusters[0]).toMatchObject({ representativeId: 'a', memberIds: ['b'] });

    expect(svc.apply(plan)).toBe(1);
    const status = (id: string) => (db.prepare('SELECT status FROM self_improvements WHERE id = ?').get(id) as { status: string }).status;
    expect([status('a'), status('b'), status('c')]).toEqual(['needs_more_evidence', 'archived', 'needs_more_evidence']);

    runMigrations(db); // the boot-time duplicate-fingerprint collapse must not delete archived rows
    expect(status('b')).toBe('archived');

    expect(svc.restore()).toBe(1);
    expect(status('b')).toBe('needs_more_evidence');
    expect((db.prepare('SELECT fingerprint FROM self_improvements WHERE id = ?').get('b') as { fingerprint: string }).fingerprint).toBe('fp-b');
  });

  it('reports why it fell back to jaccard, and bounds embedding concurrency', async () => {
    park('a', 'x', 'security vulnerability scan', 0.9);
    const plan = await new ProposalClusteringService(db, { embedder: { embed: async () => { throw new Error('ollama down'); } } }).plan();
    expect(plan).toMatchObject({ method: 'jaccard', fallbackReason: 'ollama down' });
    for (let i = 0; i < 20; i++) park(`p${i}`, `t${i}`, `topic ${i} unique words ${i}`, 0.5);
    let inFlight = 0; let peak = 0;
    const embedder = { embed: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 2)); inFlight--; return [1, 0]; } };
    await new ProposalClusteringService(db, { embedder }).plan();
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('uses embeddings when an embedder is supplied', async () => {
    park('a', 'x', 'security vulnerability scan', 0.9);
    park('b', 'y', 'typescript performance tuning', 0.5);
    const embedder = { embed: async (t: string) => t.includes('security') ? [1, 0] : [0, 1] };
    const plan = await new ProposalClusteringService(db, { embedder }).plan();
    expect(plan.method).toBe('embedding');
    expect(plan.clusters).toHaveLength(0);
  });
});

describe('refinement carries grounding', () => {
  it('parses target/test/metric from the model and stores it on the refined proposal (null means none)', async () => {
    const { SelfImprovementRefinementService } = await import('../services/self-improvement-refinement-service');
    const grounded = await new SelfImprovementRefinementService(async () => JSON.stringify({ title: 't', description: 'd', rationale: 'r', target: 'packages/server/src/x.ts', acceptance_test: 'npm test x', baseline_metric: 'null', runtime_command: 'cd packages/server && npx vitest run x', artifact_path: 'worker-output/stdout.log', budget: '5 min, 20k tokens' })).refine(
      { id: 'p', title: 'a', description: 'b', rationale: 'c' } as never, []);
    expect(grounded).toMatchObject({ target: 'packages/server/src/x.ts', acceptanceTest: 'npm test x', runtimeCommand: 'cd packages/server && npx vitest run x', artifactPath: 'worker-output/stdout.log', budget: '5 min, 20k tokens' });
    expect(grounded?.baselineMetric).toBeUndefined();

    const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    const svc = new SelfImprovementService(db);
    db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at) VALUES ('parked', 'feature', 't', 'd', 'r', 'reflection', 'needs_more_evidence', 0.5, '[\"reflection:r1\"]', datetime('now'), datetime('now'))").run();
    const child = svc.refineFromDissent('parked', grounded!)!;
    const row = db.prepare('SELECT grounding_json FROM self_improvements WHERE id = ?').get(child.id) as { grounding_json: string };
    expect(JSON.parse(row.grounding_json)).toMatchObject({ target: 'packages/server/src/x.ts', runtimeCommand: 'cd packages/server && npx vitest run x', budget: '5 min, 20k tokens', derived: false });
    db.close();
  });
});
