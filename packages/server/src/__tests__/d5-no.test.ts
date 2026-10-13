import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { D5NO_ANALYSIS_N, D5NO_CUTOFF, D5NO_PREREG_SHA256, clopperPearsonUpper, d5NoEvidence, isConfidentNo, maxErrorsAllowed, minClustersForBound } from '../services/d5-no';
import { proposalPrescreen } from '../services/judgments/proposal-prescreen';
import { buildEvolutionEvidence } from '../services/evolution-evidence';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => db.close());

const after = (min: number) => new Date(Date.parse(D5NO_CUTOFF) + min * 60_000).toISOString();
const before = (min: number) => new Date(Date.parse(D5NO_CUTOFF) - min * 60_000).toISOString();
const proposal = (id: string, status: string, created: string, opts: { refs?: string[]; description?: string; source?: string } = {}) =>
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'feature', 't', ?, 'r', ?, ?, 0.5, ?, ?, ?)`).run(id, opts.description ?? `change ${id}`, opts.source ?? 'reflection', status, JSON.stringify(opts.refs ?? []), created, created);
const prescreen = (id: string, decision: string, at: string, mode = 'shadow') =>
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'proposal_prescreen', 'self_improvement', ?, 'h', ?, ?, 'r', ?)`).run(randomUUID(), id, mode, decision, at);

it('cutoff isolation: pre-cutoff proposals, enforce-mode rows and pre-cutoff clusters never enter H-D5NO', () => {
  proposal('old', 'verified', before(60)); prescreen('old', 'no', before(59));             // JC era
  proposal('enf', 'regressed', after(5)); prescreen('enf', 'no', after(6), 'enforce');      // enforce row, not shadow
  proposal('copy', 'verified', after(10), { refs: ['requeue-of:old'] }); prescreen('copy', 'no', after(11)); // copy of a JC-era original
  proposal('new', 'regressed', after(20)); prescreen('new', 'no', after(21));
  const e = d5NoEvidence(db) as any;
  expect(e.confident_no.cases).toBe(1);
  expect(e.confident_no.false_rejection).toBe(0);
  expect(e.excluded.pre_cutoff_cluster).toBe(1);
});

it('clusters: requeue copies, refinements, near-duplicates and same-target variants are one observation; any verified ⇒ false rejection', () => {
  proposal('a', 'needs_more_evidence', after(1), { description: 'edit packages/server/src/services/x.ts' }); prescreen('a', 'no', after(2));
  proposal('b', 'verified', after(3), { refs: ['requeue-of:a'] }); prescreen('b', 'yes', after(4));
  proposal('c', 'regressed', after(5), { description: 'also packages/server/src/services/x.ts' }); prescreen('c', 'no', after(6));
  proposal('d', 'no_change', after(7)); prescreen('d', 'no', after(8));
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES (?, 'proposal_near_duplicate', 'self_improvement', 'd', 'h', 'shadow', 'yes', 'similar_to=a cosine=0.950', ?)`).run(randomUUID(), after(8));
  const e = d5NoEvidence(db) as any;
  expect(e.confident_no.cases).toBe(1);               // a, b, c, d collapse into one cluster
  expect(e.confident_no.false_rejection).toBe(1);     // b verified ⇒ the whole cluster is a false rejection
  expect(e.confident_yes.cases).toBe(0);              // the cluster's decision is its earliest member's ('no')
});

it('confident-NO is exactly the rule D5 enforce parked on (decision no), for every decide() outcome', () => {
  const src = readFileSync(join(__dirname, '../services/self-improvement-auto-review-scheduler.ts'), 'utf8');
  expect(src).toContain("prescreen.decision === 'no'");
  const vals = [undefined, 0.1, 0.5, 0.9];
  for (const n of vals) for (const v of vals) for (const c of vals) for (const s of vals) for (const pathExists of [undefined, true, false]) {
    const d = proposalPrescreen.decide({ names_file: { noul: n }, verifiable: { noul: v }, concrete: { noul: c }, sensitive: { noul: s } } as any, { pathExists });
    expect(isConfidentNo(d.decision)).toBe(d.decision === 'no');
  }
  expect(isConfidentNo('uncertain')).toBe(false);
  expect(isConfidentNo('yes')).toBe(false);
});

it('exact one-sided Clopper-Pearson bound and the preregistered sample-size rules', () => {
  expect(clopperPearsonUpper(0, 59)!).toBeCloseTo(0.0495, 3);
  expect(clopperPearsonUpper(0, 58)!).toBeGreaterThan(0.05);
  expect(clopperPearsonUpper(1, 100)!).toBeCloseTo(0.0466, 3);
  expect(clopperPearsonUpper(2, 100)!).toBeCloseTo(0.0616, 3);
  expect(minClustersForBound()).toBe(59);
  expect(maxErrorsAllowed(D5NO_ANALYSIS_N)).toBe(1);
  expect(clopperPearsonUpper(0, 0)).toBeNull();
  // the frozen protocol's fingerprint matches the constant reported by the evidence
  const doc = readFileSync(join(__dirname, '../../../../docs/research/eco/D5NO_PROTOCOL.md'), 'utf8');
  const [body, tail] = doc.split('\n---\nPREREG_SHA256: ');
  expect(createHash('sha256').update(body).digest('hex')).toBe(tail.slice(0, 64));
  expect(tail.slice(0, 64)).toBe(D5NO_PREREG_SHA256);
});

it('early REJECT once errors exceed what the maximum n allows; never early GO; YES stays descriptive', () => {
  for (let i = 0; i < 30; i++) { proposal(`n${i}`, 'regressed', after(10 + i)); prescreen(`n${i}`, 'no', after(10 + i)); }
  let e = d5NoEvidence(db) as any;
  expect(e.status).toBe('collecting');                 // 30 clean clusters: never an early GO
  proposal('f1', 'verified', after(100)); prescreen('f1', 'no', after(100));
  proposal('f2', 'verified', after(101)); prescreen('f2', 'no', after(101));
  proposal('y1', 'verified', after(102)); prescreen('y1', 'yes', after(102));
  e = d5NoEvidence(db) as any;
  expect(e.status).toBe('rejected');                   // 2 false rejections > 1 allowed at n = 100
  expect(e.confident_yes).toMatchObject({ cases: 1, false_rejection: 1 });
  expect(e.confident_no.false_rejection).toBe(2);      // YES never mixed into the NO tally
  expect(Object.keys(buildEvolutionEvidence(db))).toContain('d5_no');
});
