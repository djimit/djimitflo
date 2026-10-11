import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { decisionsInbox, recordNeedsYouRanking } from '../services/decisions-inbox';

// Cockpit 3.0 Phase 3 (shadow): needs-you ranked by measured expected gain; unmeasured = INSUFFICIENT_EVIDENCE, last
let db: Database.Database;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const proposal = (id: string, status: string, refs = '["test-gap:x"]') => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
  VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, ?, ?, ?)`).run(id, `title ${id}`, status, refs, at(48), at(1));
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

it('ranks a requeue by the measured verify rate of earlier requeues; unmeasured kinds are listed last with null score', () => {
  ['v1', 'v2', 'v3', 'v4'].forEach((id) => proposal(id, 'verified', `["requeue-of:old-${id}"]`));
  proposal('x1', 'regressed', '["requeue-of:old-x1"]');
  proposal('cand', 'infra_failed');
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at) VALUES ('run1', 'test-gap', 'closed', 'completed', ?, ?, ?)`)
    .run(JSON.stringify({ pr_url: 'https://github.com/djimit/djimitflo/pull/9' }), at(30), at(30));
  const r = decisionsInbox(db, NOW).ranking;
  const req = r.find((i) => i.kind === 'requeue' && i.id === 'cand');
  expect(req?.expected_gain).toBe(0.8);
  expect(req?.score).toBe(0.8);
  expect(req?.evidence[0]).toContain('4/5');
  const pr = r.find((i) => i.kind === 'loop_pr');
  expect(pr?.score).toBeNull(); // no settled merge outcome yet → never a guessed number
  expect(pr?.evidence[0]).toMatch(/^INSUFFICIENT_EVIDENCE/);
  expect(r[0].id).toBe('cand'); // measured before unmeasured
  expect(r.indexOf(pr!)).toBeGreaterThan(r.indexOf(req!));
});

it('below the minimum sample the requeue gain is INSUFFICIENT_EVIDENCE, not a rate from 1 attempt', () => {
  proposal('v1', 'verified', '["requeue-of:old"]');
  proposal('cand', 'infra_failed');
  const req = decisionsInbox(db, NOW).ranking.find((i) => i.id === 'cand');
  expect(req?.score).toBeNull();
  expect(req?.evidence[0]).toContain('need 5');
});

it('records one shadow ranking judgment per UTC day and changes nothing else', () => {
  proposal('cand', 'infra_failed');
  const before = db.prepare("SELECT status FROM self_improvements WHERE id = 'cand'").get();
  expect(recordNeedsYouRanking(db, NOW)).toBe(true);
  expect(recordNeedsYouRanking(db, NOW + 3_600_000)).toBe(false);
  const rows = db.prepare("SELECT mode, subject_id, answers_json FROM judgments WHERE judgment = 'needs_you_ranking'").all() as Array<{ mode: string; subject_id: string; answers_json: string }>;
  expect(rows).toHaveLength(1);
  expect(rows[0].mode).toBe('shadow');
  expect(rows[0].subject_id).toBe('2026-10-10');
  expect(JSON.parse(rows[0].answers_json)[0].id).toBe('cand');
  expect(db.prepare("SELECT status FROM self_improvements WHERE id = 'cand'").get()).toEqual(before);
  expect(db.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
});
