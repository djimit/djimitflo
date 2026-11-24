import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { MIN_N, privateHost, replayCases, score, type ScoredCase } from '../scripts/system-one-replay';

const answers = (p: number) => ({ names_file: { noul: 1 }, verifiable: { noul: 1 }, concrete: { noul: p }, sensitive: { noul: 0 } });

it('GLD-001 §2: only resolved proposals whose stored state hash matches the text, earliest non-error jev row', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  const add = (id: string, status: string, created: string, hash: string | null, decision = 'yes') => {
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
      VALUES (?, 'feature', 't', ?, 'r', 'gap_analysis', ?, '[]', ?, ?)`).run(id, `d ${id}`, status, created, created);
    const h = hash ?? createHash('sha256').update(JSON.stringify({ proposal: { type: 'feature', title: 't', description: `d ${id}`, rationale: 'r' } })).digest('hex').slice(0, 16);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'proposal_prescreen', 'self_improvement', ?, ?, 'shadow', ?, 'r', ?, ?)`).run(`j-${id}`, id, h, decision, JSON.stringify(answers(0.9)), created);
  };
  add('ok', 'verified', '2026-10-10T00:00:00.000Z', null);
  add('neg', 'regressed', '2026-10-11T00:00:00.000Z', null);
  add('edited', 'verified', '2026-10-12T00:00:00.000Z', 'deadbeefdeadbeef'); // text changed after the judgment
  add('open', 'proposed', '2026-10-13T00:00:00.000Z', null);                  // not resolved
  add('old', 'verified', '2026-09-01T00:00:00.000Z', null);                   // before the window
  add('err', 'verified', '2026-10-14T00:00:00.000Z', null, 'error');          // no usable jev answer
  const { cases, dropped_hash_mismatch } = replayCases(db, '2026-10-03T00:00:00.000Z');
  expect(cases.map((c) => [c.id, c.outcome])).toEqual([['ok', 1], ['neg', 0]]);
  expect(dropped_hash_mismatch).toBe(1);
  expect(cases[0].state).toEqual({ proposal: { type: 'feature', title: 't', description: 'd ok', rationale: 'r' } });
  db.close();
});

const cases = (n: number, challenger: (outcome: number, i: number) => number | null): ScoredCase[] => Array.from({ length: n }, (_, i) => {
  const outcome = (i % 2) as 0 | 1; const p = challenger(outcome, i);
  return { source: 'gap_analysis', outcome, description: 'packages/server/src/a.ts', a: answers(0.4 + (i % 7) / 20), b: p === null ? null : answers(p) };
});

it('GLD-001 §5: verdict from the paired ΔAUC interval; too few scored cases are insufficient, never a zero', () => {
  const better = score(cases(MIN_N, (o) => (o ? 0.9 : 0.1)), { boot: 200 });
  expect(better.verdict).toBe('SUPPORTED');
  expect(better.challenger?.auc).toBe(1);
  expect(better.delta_auc_ci95?.[0]).toBeGreaterThan(0);
  expect(score(cases(MIN_N, (o) => (o ? 0.1 : 0.9)), { boot: 200 }).verdict).toBe('NOT_SUPPORTED');
  const same = score(cases(MIN_N, (_o, i) => 0.4 + (i % 7) / 20), { boot: 200 });
  expect([same.verdict, same.delta_auc, same.decision_agreement]).toEqual(['EQUIVALENT', 0, 1]);
  const few = score(cases(MIN_N - 2, (o) => (o ? 0.9 : 0.1)));
  expect([few.verdict, few.delta_auc_ci95]).toEqual(['INSUFFICIENT_EVIDENCE', null]);
  // more than 10 % challenger errors: not scored, not imputed
  const failing = score(cases(MIN_N + 60, (o, i) => (i < 40 ? null : o ? 0.9 : 0.1)));
  expect([failing.verdict, failing.errors, failing.n_scored]).toEqual(['INSUFFICIENT_EVIDENCE', 40, MIN_N + 20]);
});

it('refuses a challenger outside loopback and private ranges', () => {
  for (const u of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://100.81.133.48:8000', 'http://192.168.1.5:8000', 'http://10.0.0.2']) expect(privateHost(u)).toBe(true);
  for (const u of ['https://api.fastino.ai', 'http://100.1.2.3:8000', 'http://172.32.0.1', 'not a url']) expect(privateHost(u)).toBe(false);
});
