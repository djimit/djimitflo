import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { requeueImprovement } from '../services/improvement-requeue';
import { assignmentContext } from '../services/assignment-context';
import { ace001Evidence, aceArm, aceDelivery } from '../services/ace-001';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

// ACE-001 Amendment 1 (prod 11-10): requeued oracle proposals had no stored vector, so treated arms fell back to control
let db: Database.Database; let checkout: string;
const now = new Date().toISOString();
const blob = (v: number[]) => { const f = new Float32Array(v); return Buffer.from(f.buffer, f.byteOffset, f.byteLength); };
const proposal = (id: string, status: string, refs: string[], updated = now, artifact?: string) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
  VALUES (?, 'feature', ?, 'd', 'r', 'gap_analysis', ?, 0.5, ?, ?, ?, ?)`).run(id, `Add unit tests for ${id}`, status, JSON.stringify(refs), artifact ? JSON.stringify({ target: 'x', artifactPath: artifact }) : null, updated, updated);
const embedding = (id: string, v: number[]) => db.prepare('INSERT INTO proposal_embeddings (proposal_id, model, vector, created_at) VALUES (?, ?, ?, ?)').run(id, 'test', blob(v), now);
const goalIn = (code: string) => { for (let i = 0; ; i++) if (aceArm(`goal-${i}`).code === code) return `goal-${i}`; };
const goal = (id: string, improvementId: string) => db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'running', '{}', ?, ?, ?)`).run(id, improvementId, now, now);

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  db.exec('CREATE TABLE IF NOT EXISTS proposal_embeddings (proposal_id TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL)');
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-d-'));
  fs.mkdirSync(path.join(checkout, 'packages/server/src/__tests__'), { recursive: true });
});
afterEach(() => { db.close(); fs.rmSync(checkout, { recursive: true, force: true }); });

it('a requeued oracle proposal inherits its original vector (no network), so ACE-001 can treat it', () => {
  proposal('orig', 'regressed', ['test-gap:board']); embedding('orig', [1, 0, 0]);
  const { id } = requeueImprovement(db, 'orig', { actor: 'op', reason: 'reviewer failure' }, { TEST_GAP_MAX_PER_DAY: '8' });
  const row = db.prepare('SELECT vector FROM proposal_embeddings WHERE proposal_id = ?').get(id) as { vector: Buffer } | undefined;
  expect(row?.vector.equals(blob([1, 0, 0]))).toBe(true);
});

it('control (arm 00) gets exactly the production examples; a treated fallback records why', () => {
  const p = 'packages/server/src/__tests__/old.test.ts'; fs.writeFileSync(path.join(checkout, p), '//');
  proposal('old', 'verified', ['test-gap:old'], now, p);
  proposal('cur', 'executing', ['test-gap:cur']); // no vector
  const g0 = goalIn('00'); goal(g0, 'cur');
  const base = { LOOP_SKILL_CARDS_ENABLED: 'true' };
  const prod = assignmentContext(db, { id: 'r-prod', goal_id: g0 }, checkout, 'a', base);
  const ctl = assignmentContext(db, { id: 'r-ctl', goal_id: g0 }, checkout, 'a', { ...base, ACE_001_MODE: 'on' });
  expect(ctl.examples).toEqual(prod.examples);
  proposal('cur2', 'executing', ['test-gap:cur2']); // no vector
  const g1 = goalIn('11'); goal(g1, 'cur2');
  const t = assignmentContext(db, { id: 'r-t', goal_id: g1 }, checkout, 'a', { ...base, ACE_001_MODE: 'on' });
  expect(t.ace?.fallback).toEqual(['s', 'r']);
  expect(t.ace?.fallback_reason).toBe('no_embedding');
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'proposal_embedding', 'self_improvement', 'cur2', 'embed', 'shadow', 'error', 'x', ?)`).run(randomUUID(), now);
  expect(assignmentContext(db, { id: 'r-t2', goal_id: g1 }, checkout, 'a', { ...base, ACE_001_MODE: 'on' }).ace?.fallback_reason).toBe('embedding_failed');
});

it('evidence counts only outcomes from analysis_since; earlier ones are delivery_invalid', () => {
  new SkillEvolutionEngine(db); // creates skill_outcomes
  const out = (at: string) => db.prepare(`INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at)
    VALUES (?, 'loop-maker:test-gap:opencode', 1, 10, 1, 'x', ?, 'a', ?, ?)`).run(randomUUID(), randomUUID(), JSON.stringify(['ace-001-arm:01']), at);
  out('2026-10-11T10:00:00Z'); out('2026-10-12T10:00:00Z');
  const ev = ace001Evidence(db, '2026-10-01T00:00:00Z', { ACE_001_ANALYSIS_SINCE: '2026-10-12T00:00:00Z' });
  expect(ev.delivery_invalid).toBe(1);
  expect(ev.arms['01'].n).toBe(1);
  expect(ev.analysis_since).toBe('2026-10-12T00:00:00Z');
});

it('delivery rate per factor: treated slots that actually got the treatment', () => {
  const ev = (run: string, arm: string, fallback: string[]) => db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at)
    VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)`).run(randomUUID(), run, JSON.stringify({ ace_001: { arm, lane: 'test-gap', examples_source: 'recency', kb_paths: [], fallback, ...(fallback.length ? { fallback_reason: 'no_embedding' } : {}) } }), now);
  ev('a', '11', ['s', 'r']); ev('b', '11', []); ev('c', '01', ['s']); ev('d', '10', []); ev('e', '00', []);
  const d = aceDelivery(db, '2026-01-01T00:00:00Z');
  expect(d.retrieval_rate).toBeCloseTo(2 / 3); // arm 11 ×2 + arm 10: delivered b, d
  expect(d.examples_rate).toBeCloseTo(1 / 3); // arm 11 ×2 + arm 01: delivered b
  expect(d.fallback_reasons.no_embedding).toBe(2);
});
