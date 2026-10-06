import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { ExpertSourceUnitsService } from '../services/expert-source-units-service';
import { PacingFrontierIngestionService } from '../services/pacing-frontier-ingestion-service';
import { ExpertEvidenceEnrichmentService } from '../services/expert-evidence-enrichment-service';
import { ExpertResolverService } from '../services/expert-resolver-service';
import { buildPerspectivePrompt } from '../services/expert-perspective-builder';
import { areaId, syncAreas } from '../services/expert-areas';
import { applyWithBackup, migratePersonsToAreas } from '../services/expert-persons-migration';
import { createSwarmRoutes } from '../routes/swarms';
import { errorHandler } from '../middleware/error-handler';

const NAME = 'Ada Example-Researcher';
afterEach(() => vi.unstubAllEnvs());

function setup() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  const registry = new FrontierExpertRegistryService(db); registry.seedTaxonomy();
  return { db, registry };
}

/** A person with every kind of history, a paper unit derived from the person's stored paper, and a swarm run naming them. */
function seedPerson(db: Database.Database, registry: FrontierExpertRegistryService) {
  const person = registry.discover({ canonicalName: NAME, aliases: ['A. Example-Researcher'], provenance: { source: 'pacingthefrontier', seed_title: 'Head of oversight, BigLab' }, actor: 'ingestion:test' });
  const paper = registry.addEvidence(person.id, { kind: 'paper', title: 'Scalable oversight with debate', url: 'https://arxiv.org/abs/2601.00001', sourceRef: 'arxiv:2601.00001',
    metadata: { arxiv_id: '2601.00001', abstract: 'We study scalable oversight with debate.', categories: ['cs.LG'], authors: [NAME] } });
  registry.addEvidence(person.id, { kind: 'signature', title: `${NAME} signed the statement`, sourceRef: 'pacing:sig-1' });
  registry.addEvidence(person.id, { kind: 'profile', title: `${NAME} — homepage`, url: 'https://example.org/~ada', sourceRef: 'profile:ada' });
  registry.addAffiliation(person.id, { organization: 'BigLab', role: 'Head of oversight', sourceRef: 'pacing:sig-1' });
  registry.inferCapability(person.id, { capability: 'scalable_oversight', confidence: 0.8, evidenceRefs: [paper], derivedBy: 'test' });
  registry.addClaim({ expertId: person.id, subject: 'debate', relation: 'improves', object: 'oversight', evidenceRefs: [paper], confidence: 0.6 });
  new ExpertSourceUnitsService(db).materialize(20);
  db.exec("CREATE TABLE IF NOT EXISTS expert_swarm_history (id TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.prepare('INSERT INTO expert_swarm_history (id, result_json) VALUES (?, ?)').run('h1', JSON.stringify({ perspectives: [{ canonical_name: NAME, expert_id: person.id }], count: 1 }));
  return person;
}

it('FE-AREAS: the people pipeline creates no person while FRONTIER_EXPERT_PERSONS_ENABLED is off', async () => {
  const { db, registry } = setup();
  const html = '<li class="signatory"><span class="name">Ada Example</span><span class="title">Head of X, Lab</span></li>';
  const result = await new PacingFrontierIngestionService(db, { registry }).ingest({ actor: 'ingestion:test', html });
  expect(result).toMatchObject({ fetched: false, skipped_reason: 'persons_disabled', discovered_new: 0 });
  expect(await new ExpertEvidenceEnrichmentService(db, { registry }).enrichBatch({ actor: 'test' })).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) n FROM expert_identities WHERE kind = 'person'").get()).toEqual({ n: 0 });
});

it('FE-AREAS: syncAreas makes one area per taxonomy field, links the paper/repository units of that field, and is idempotent', () => {
  const { db, registry } = setup();
  seedPerson(db, registry);
  const first = syncAreas(db);
  expect(first.areas).toBe((db.prepare('SELECT COUNT(*) n FROM expert_capability_taxonomy').get() as { n: number }).n);
  const area = registry.get(areaId('scalable_oversight'))!;
  expect(area).toMatchObject({ kind: 'area', canonical_name: 'Scalable oversight', lifecycle_state: 'CAPABILITY_INFERRED' });
  const evidence = db.prepare('SELECT kind, source_ref FROM expert_evidence WHERE expert_id = ?').all(area.id) as Array<{ kind: string; source_ref: string }>;
  const unit = db.prepare("SELECT id FROM expert_identities WHERE kind = 'paper'").get() as { id: string };
  expect(evidence).toEqual([{ kind: 'paper', source_ref: unit.id }]);
  expect(db.prepare("SELECT capability_id FROM expert_capabilities WHERE expert_id = ?").all(area.id)).toEqual([{ capability_id: 'scalable_oversight' }]);
  const version = registry.get(area.id)!.version;
  expect(syncAreas(db)).toEqual({ areas: 0, linked: 0 });
  expect(registry.get(area.id)!.version).toBe(version); // unchanged area, no new history
});

it('FE-AREAS: the API never lists or shows a person; areas are listed, and an area is a council perspective', async () => {
  const { db, registry } = setup();
  const person = seedPerson(db, registry);
  syncAreas(db);
  const auth = { requirePermission: () => (req: any, _res: any, next: any) => { req.user = { sub: 'op-1', email: 'op@test' }; next(); } } as any;
  const app = express().use(express.json()).use('/swarms', createSwarmRoutes(db, auth)).use(errorHandler);
  const list = await request(app).get('/swarms/expert/experts?limit=200');
  expect(list.status).toBe(200);
  expect((list.body.experts as Array<{ kind: string }>).some((e) => e.kind === 'person')).toBe(false);
  expect((list.body.experts as Array<{ kind: string }>).some((e) => e.kind === 'area')).toBe(true);
  expect((list.body.funnel as Array<{ kind: string }>).some((row) => row.kind === 'person')).toBe(false);
  expect((await request(app).get('/swarms/expert/experts?kind=person')).body.error.code).toBe('VALIDATION_ERROR');
  expect((await request(app).get(`/swarms/expert/experts/${person.id}`)).status).toBe(404);
  const resolved = new ExpertResolverService(db).resolve('How does debate help scalable oversight?', { maxExperts: 3 });
  expect(resolved.experts.map((e) => e.expert_id)).toContain(areaId('scalable_oversight'));
  const prompt = buildPerspectivePrompt({ expert: { id: areaId('scalable_oversight'), canonical_name: 'Scalable oversight', capabilities: ['scalable_oversight'] }, question: 'q?', evidence: [], procedure: null });
  expect(prompt.system).toContain('field of interest "Scalable oversight"');
  expect(prompt.system).not.toContain('You are NOT this person');
});

it('FE-AREAS: the migration moves public-work evidence to areas, deletes the people with all their history, and leaves no name behind', async () => {
  const { db, registry } = setup();
  const person = seedPerson(db, registry);
  const dry = migratePersonsToAreas(db);
  expect(dry.persons).toBe(1);
  expect(db.prepare("SELECT COUNT(*) n FROM expert_identities WHERE kind = 'person'").get()).toEqual({ n: 1 }); // dry-run wrote nothing
  expect(db.prepare("SELECT COUNT(*) n FROM expert_identities WHERE kind = 'area'").get()).toEqual({ n: 0 });

  await expect(applyWithBackup(db, undefined)).rejects.toThrow('FE_AREAS_BACKUP_REQUIRED');
  const backup = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fe-areas-')), 'backup.sqlite');
  const report = await applyWithBackup(db, backup);
  expect(new Database(backup, { readonly: true }).prepare("SELECT COUNT(*) n FROM expert_identities WHERE kind = 'person'").get()).toEqual({ n: 1 });
  expect(report).toMatchObject({ persons: 1, moved_evidence: 1, dropped_evidence: 2, check: { persons_left: 0, dangling_refs: 0, name_hits: [] } });
  for (const table of ['expert_affiliations', 'expert_capabilities', 'expert_claims', 'expert_versions', 'expert_lifecycle_events', 'expert_evidence']) {
    expect(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE expert_id = ?`).get(person.id)).toEqual({ n: 0 });
  }
  const areaEvidence = db.prepare('SELECT kind, canonical_origin, metadata_json FROM expert_evidence WHERE expert_id = ? ORDER BY canonical_origin').all(areaId('scalable_oversight')) as Array<{ kind: string; canonical_origin: string; metadata_json: string }>;
  expect(areaEvidence.map((e) => e.canonical_origin)).toContain('https://arxiv.org/abs/2601.00001');
  expect(areaEvidence.every((e) => !e.metadata_json.includes(NAME))).toBe(true);
  expect((db.prepare("SELECT result_json FROM expert_swarm_history WHERE id = 'h1'").get() as { result_json: string }).result_json).not.toContain(NAME);
  // nothing anywhere in the expert tables still carries the name
  const dump = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'expert_%'").all() as Array<{ name: string }>)
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t.name}`).all())).join('\n');
  expect(dump).not.toContain(NAME);
  expect(migratePersonsToAreas(db, { apply: true })).toMatchObject({ persons: 0 }); // a second run is a no-op
});
