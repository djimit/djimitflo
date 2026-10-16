import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';
import { canonicalId, expertUnitDedupe, normaliseTitle, unitKey } from '../services/expert-unit-dedupe';

const NOW = Date.parse('2026-10-16T12:00:00Z');
let db: Database.Database;
let seq = 0;
const unit = (id: string, kind: string, name: string, aliases: string[], opts: { at?: string; state?: string; evidence?: number; claims?: number; provenance?: Record<string, unknown> } = {}) => {
  db.prepare(`INSERT INTO expert_identities (id, canonical_name, aliases_json, lifecycle_state, identity_confidence, provenance_json, version, kind, created_at)
    VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?)`).run(id, name, JSON.stringify(aliases), opts.state ?? 'CAPABILITY_INFERRED', JSON.stringify(opts.provenance ?? {}), kind, opts.at ?? '2026-10-01 00:00:00');
  for (let i = 0; i < (opts.evidence ?? 1); i++) evidence(id, `ref-${id}-${i}`);
  for (let i = 0; i < (opts.claims ?? 0); i++) db.prepare(`INSERT INTO expert_claims (id, expert_id, subject, relation, object, evidence_refs_json, confidence) VALUES (?, ?, 's', 'r', 'o', '["e"]', 0.5)`).run(`c-${++seq}`, id);
};
const evidence = (expertId: string, sourceRef: string) => db.prepare(`INSERT INTO expert_evidence (id, expert_id, kind, tier, title, source_ref, source_family, canonical_origin, retrieved_at)
  VALUES (?, ?, 'paper', 1, 't', ?, 'f', 'o', '2026-10-01')`).run(`ev-${++seq}`, expertId, sourceRef);
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

/** The fixture: 13 units, 8 distinct works (arXiv v1/v2/bare, DOI case, title punctuation, GitHub case), 5 duplicates. */
const fixture = () => {
  unit('p1', 'paper', 'Sparse Agents', ['arxiv:2401.12345v1'], { at: '2026-09-01 00:00:00' });
  unit('p2', 'paper', 'Sparse agents (v2)', ['arxiv:2401.12345v2'], { at: '2026-09-05 00:00:00', evidence: 2, claims: 1, state: 'EVIDENCE_COLLECTED' });
  unit('p3', 'paper', 'Sparse Agents', ['2401.12345'], { at: '2026-09-09 00:00:00' });
  unit('d1', 'paper', 'A DOI work', ['doi:10.1000/ABC.Def']);
  unit('d2', 'paper', 'A DOI work, published', ['https://doi.org/10.1000/abc.def'], { at: '2026-10-02 00:00:00' });
  unit('t1', 'paper', 'Attention Is All You Need!', ['scout:foo']);
  unit('t2', 'paper', 'attention   is all — you need', [], { at: '2026-10-03 00:00:00' });
  unit('t3', 'paper', 'Attention Is All You Need', ['arxiv:1706.03762']); // has an id: stays apart from the title-only pair
  unit('x1', 'paper', 'Sparse Agents', ['arxiv:2401.12346']); // same title, different arXiv work: stays apart
  unit('x2', 'paper', 'Other work', ['arxiv:2401.99999']);
  unit('r1', 'repository', 'owner/repo', ['github:owner/repo']);
  unit('r2', 'repository', 'Owner/Repo', ['github:OWNER/Repo.git'], { at: '2026-10-04 00:00:00' });
  unit('area:agent_memory', 'area', 'Agent memory', ['agent_memory'], { evidence: 0 });
  evidence('area:agent_memory', 'p1'); evidence('area:agent_memory', 'p3'); evidence('area:agent_memory', 'p2');
  unit('person-1', 'person', 'A Person', ['arxiv:2401.12345']); // persons are never part of the report
};

beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); seq = 0; });

describe('FE-DEDUPE keys (pure)', () => {
  it('arXiv v1/v2/bare/abs-url/arXiv-DOI all give the same id; DOI is case-insensitive; GitHub is lowercased', () => {
    const ids = ['arxiv:2401.12345v1', 'arxiv:2401.12345v2', '2401.12345', 'https://arxiv.org/abs/2401.12345v3', '10.48550/arXiv.2401.12345'].map(canonicalId);
    expect(new Set(ids.map((i) => JSON.stringify(i))).size).toBe(1);
    expect(ids[0]).toEqual({ type: 'arxiv', value: '2401.12345' });
    expect(canonicalId('doi:10.1000/ABC.Def')).toEqual(canonicalId('https://doi.org/10.1000/abc.def'));
    expect(canonicalId('github:OWNER/Repo.git')).toEqual({ type: 'github', value: 'owner/repo' });
    expect(canonicalId('scout:foo')).toBeNull();
    expect(canonicalId('arxiv:2401.12345')).not.toEqual(canonicalId('arxiv:2401.12346'));
  });

  it('title normalisation: NFKC, lowercase, punctuation and whitespace collapsed', () => {
    expect(normaliseTitle('Attention Is All You Need!')).toBe('attention is all you need');
    expect(normaliseTitle('attention   is all — you need')).toBe('attention is all you need');
    expect(normaliseTitle('ＦＵＬＬ－width: Title')).toBe('full width title');
    expect(unitKey({ kind: 'paper', canonical_name: 'X', aliases_json: '[]', provenance_json: '{"ref":"arxiv:2501.00001v4"}' })).toEqual({ type: 'arxiv', value: '2501.00001' });
    expect(unitKey({ kind: 'repository', canonical_name: 'Foo/Bar', aliases_json: '[]', provenance_json: '{}' })).toEqual({ type: 'github', value: 'foo/bar' });
    expect(unitKey({ kind: 'paper', canonical_name: '  ', aliases_json: '[]', provenance_json: '{}' })).toEqual({ type: 'none', value: '' });
  });
});

describe('FE-DEDUPE report (read-only)', () => {
  it('clusters duplicates, keeps different works apart, picks the canonical member and writes nothing', () => {
    fixture();
    const tables = ['expert_identities', 'expert_evidence', 'expert_claims', 'expert_capabilities', 'judgments'];
    const before = tables.map((t) => count(`SELECT COUNT(*) AS n FROM ${t}`));
    const r = expertUnitDedupe(db, { now: NOW });
    expect(tables.map((t) => count(`SELECT COUNT(*) AS n FROM ${t}`))).toEqual(before);
    expect(r.writes).toBe(0);
    expect(r.totals).toEqual({ units: 13, clusters: 8, duplicate_units: 5, inflation_factor: 1.625, duplicate_clusters: 4, distinct_titles: 8 });
    expect(r.by_kind).toEqual([
      { kind: 'paper', units: 10, clusters: 6, duplicate_units: 4, inflation_factor: 1.667 },
      { kind: 'repository', units: 2, clusters: 1, duplicate_units: 1, inflation_factor: 2 },
      { kind: 'area', units: 1, clusters: 1, duplicate_units: 0, inflation_factor: 1 },
    ]);
    expect(r.by_key_type.find((k) => k.key_type === 'arxiv')).toEqual({ key_type: 'arxiv', units: 6, clusters: 4, duplicate_units: 2, inflation_factor: 1.5 });
    const arxiv = r.top_clusters[0];
    expect(arxiv).toMatchObject({ kind: 'paper', key_type: 'arxiv', key: '2401.12345', size: 3, canonical: 'p2', states: { CAPABILITY_INFERRED: 2, EVIDENCE_COLLECTED: 1 },
      would_move: { evidence: 2, claims: 0, capabilities: 0, area_links: 2 } });
    expect(arxiv.members.map((m) => m.id)).toEqual(['p2', 'p1', 'p3']); // most evidence, then oldest
    const keys = r.top_clusters.map((c) => `${c.kind}:${c.key_type}:${c.key}`);
    expect(keys).toEqual(expect.arrayContaining(['paper:doi:10.1000/abc.def', 'paper:title:attention is all you need', 'repository:github:owner/repo']));
    expect(r.top_clusters.find((c) => c.key_type === 'title')!.members.map((m) => m.id)).toEqual(['t1', 't2']); // t3 (arXiv id) stays apart
    expect(r.top_clusters.flatMap((c) => c.members.map((m) => m.id))).not.toContain('x1');
    expect(r.top_clusters.find((c) => c.key_type === 'github')!.canonical).toBe('r1'); // tie on evidence → oldest
  });

  it('reports the FE metrics a collapse would change, computed; gap_demand unknown (null) while feedback is off', () => {
    fixture();
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('run-1', 'l', 'closed', 'completed', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(new Date(NOW - 86_400_000).toISOString(), new Date(NOW - 86_400_000).toISOString());
    db.exec('CREATE TABLE IF NOT EXISTS outcome_credits (run_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (run_id, kind, ref))');
    for (const ref of ['expert_unit:p1', 'expert_unit:p3', 'expert_unit:x2']) db.prepare("INSERT INTO outcome_credits VALUES ('run-1', 'knowledge', ?, '2026-10-15')").run(ref);
    const m = expertUnitDedupe(db, { now: NOW, env: {} }).metrics_if_collapsed;
    expect(m.funnel).toMatchObject({ units_before: 13, units_after: 8, cells_changed: 2 });
    expect(m.funnel.cells).toEqual([{ kind: 'paper', state: 'CAPABILITY_INFERRED', before: 9, after: 5 }, { kind: 'repository', state: 'CAPABILITY_INFERRED', before: 2, after: 1 }]);
    expect(m.gap_demand).toBeNull();
    expect(m.knowledge_fitness).toEqual({ inventory_before: 12, inventory_after: 7, used_items_before: 3, used_items_after: 2, used_items_in_duplicate_clusters: 2, unused_before: 9, unused_after: 5 });
  });

  it('gap_demand: with feedback on, a duplicate area stops double-counting its demand', () => {
    db.prepare("INSERT OR IGNORE INTO expert_capability_taxonomy (id, label) VALUES ('agent_memory', 'Agent memory')").run();
    unit('area:a', 'area', 'Agent Memory', ['agent_memory'], { evidence: 0, at: '2026-09-01 00:00:00' });
    unit('area:b', 'area', 'agent memory', ['agent_memory'], { evidence: 0 });
    for (const id of ['area:a', 'area:b']) db.prepare(`INSERT INTO expert_capabilities (id, expert_id, capability_id, confidence, evidence_refs_json, derived_by) VALUES (?, ?, 'agent_memory', 0.6, '["e"]', 't')`).run(`cap-${id}`, id);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES ('dg', 'evolution_digest', 'evolution_digest', '2026-10-16', 'h', 'shadow', 'yes', 'r', ?, '2026-10-16')`).run(JSON.stringify({ gap_demand: { agent_memory: 3 } }));
    const r = expertUnitDedupe(db, { now: NOW, env: { EVOLUTION_FEEDBACK_MODE: 'on' } });
    expect(r.metrics_if_collapsed.gap_demand).toEqual({ areas_annotated_before: 2, areas_annotated_after: 1, total_before: 6, total_after: 3 });
    expect(r.top_clusters[0]).toMatchObject({ kind: 'area', key_type: 'title', canonical: 'area:a', would_move: { capabilities: 1 } });
  });

  it('GET /api/health/expert-dedupe requires authentication (read:evidence) and is read-only for a viewer', async () => {
    fixture();
    const auth = new AuthService(db);
    const viewer = auth.generateToken(auth.createUser('dedupe-viewer@example.test', 'disposable-password', UserRole.VIEWER));
    const app = express().use('/api/health', createHealthRoutes(db, createAuthMiddleware(auth)));
    expect((await request(app).get('/api/health/expert-dedupe')).status).toBe(401);
    expect((await request(app).get('/api/health/expert-dedupe').set('Authorization', 'Bearer not-a-token')).status).toBe(401);
    const units = count('SELECT COUNT(*) AS n FROM expert_identities');
    const res = await request(app).get('/api/health/expert-dedupe?limit=2').set('Authorization', `Bearer ${viewer}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totals: { units: 13, clusters: 8 }, writes: 0 });
    expect(res.body.top_clusters).toHaveLength(2);
    expect(count('SELECT COUNT(*) AS n FROM expert_identities')).toBe(units);
  });
});
