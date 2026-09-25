import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { ExpertSourceUnitsService } from '../services/expert-source-units-service';

function setup() {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
  const registry = new FrontierExpertRegistryService(db); registry.seedTaxonomy();
  const person = registry.discover({ canonicalName: 'A Researcher', provenance: { source: 'test' }, actor: 'ingestion:test' });
  const paper = (id: string, title: string, abstract: string) => registry.addEvidence(person.id, { kind: 'paper', title, url: `https://arxiv.org/abs/${id}`, sourceRef: `arxiv:${id}`,
    metadata: { arxiv_id: id, abstract, categories: ['cs.LG'], primary_category: 'cs.LG', authors: ['A Researcher'] } });
  return { db, registry, paper };
}

it('turns stored papers, and the repositories they link, into evidence-backed units that stop at CAPABILITY_INFERRED', () => {
  const { db, paper } = setup();
  paper('2601.00001', 'Scalable oversight with debate', 'We study scalable oversight. Code: https://github.com/Lab/Debate-Kit.');
  paper('2601.00002', 'A note on nothing in particular', 'No taxonomy topic here.');
  const svc = new ExpertSourceUnitsService(db);
  expect(svc.materialize(20)).toEqual({ papers: 1, repositories: 1 });
  const units = db.prepare("SELECT kind, canonical_name AS name, lifecycle_state AS state, identity_confidence AS conf FROM expert_identities WHERE kind != 'person' ORDER BY kind").all();
  expect(units).toEqual([
    { kind: 'paper', name: 'Scalable oversight with debate', state: 'CAPABILITY_INFERRED', conf: 1 },
    { kind: 'repository', name: 'lab/debate-kit', state: 'CAPABILITY_INFERRED', conf: 1 },
  ]);
  const caps = db.prepare("SELECT e.kind, c.capability_id AS cap, c.status FROM expert_capabilities c JOIN expert_identities e ON e.id = c.expert_id WHERE e.kind != 'person' ORDER BY e.kind").all();
  expect(caps).toEqual([{ kind: 'paper', cap: 'scalable_oversight', status: 'inferred' }, { kind: 'repository', cap: 'scalable_oversight', status: 'inferred' }]);
  expect(svc.materialize(20)).toEqual({ papers: 0, repositories: 0 }); // idempotent
  expect(db.prepare("SELECT COUNT(*) AS n FROM expert_identities WHERE lifecycle_state = 'ACTIVE'").get()).toEqual({ n: 0 }); // never promotes
});

it('the governed promotion still refuses an automated actor on a unit (two humans stay required)', () => {
  const { db, registry, paper } = setup();
  paper('2601.00003', 'Mechanistic interpretability of circuits', 'Mechanistic interpretability study.');
  new ExpertSourceUnitsService(db).materialize(5);
  const unit = db.prepare("SELECT id FROM expert_identities WHERE kind = 'paper'").get() as { id: string };
  registry.transition(unit.id, 'CHECKED', { actor: 'human:checker' });
  expect(() => registry.transition(unit.id, 'APPROVED', { actor: 'ingestion:source-units' })).toThrow();
  expect(() => registry.transition(unit.id, 'APPROVED', { actor: 'human:checker' })).toThrow('EXPERT_APPROVER_MUST_DIFFER_FROM_CHECKER');
});

it('G1: a fleet agent discovery becomes a unit only when it is identifiable and on-topic, once', () => {
  const { db } = setup();
  const svc = new ExpertSourceUnitsService(db);
  const paper = { event_type: 'discovery.paper', ref: 'https://arxiv.org/abs/2609.12345v2', title: 'Scalable oversight for coding agents', note: 'debate protocol', agent: 'hermes-macmini' };
  expect(svc.ingestDiscovery(paper)).toBe('unit');
  expect(svc.ingestDiscovery(paper)).toBe('known');
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2609.99999', title: 'Qubit error rates in trapped ions', agent: 'hermes-macmini' })).toBe('irrelevant');
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'not-an-id', title: 'Scalable oversight' })).toBe('invalid');
  expect(svc.ingestDiscovery({ event_type: 'discovery.repository', ref: 'github:Org/Oversight-Kit.git', title: 'Scalable oversight toolkit', agent: 'eve-v' })).toBe('unit');
  const units = db.prepare("SELECT kind, canonical_name AS name, lifecycle_state AS state, aliases_json AS aliases FROM expert_identities WHERE kind != 'person' ORDER BY kind").all();
  expect(units).toEqual([
    { kind: 'paper', name: 'Scalable oversight for coding agents', state: 'CAPABILITY_INFERRED', aliases: '["arxiv:2609.12345"]' },
    { kind: 'repository', name: 'org/oversight-kit', state: 'CAPABILITY_INFERRED', aliases: '["github:org/oversight-kit"]' },
  ]);
  expect(db.prepare("SELECT source_family FROM expert_evidence WHERE source_ref = 'arxiv:2609.12345'").get()).toEqual({ source_family: 'agent:hermes-macmini' });
  expect(svc.materialize(20)).toEqual({ papers: 0, repositories: 0 }); // stored fleet evidence is not re-materialised
});
