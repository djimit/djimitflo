import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { assignmentContext, assignmentContextMarkdown } from '../services/assignment-context';
import { ACE_ARMS, ace001Evidence, aceArm } from '../services/ace-001';
import { daemonCheckOptions } from '../services/loop-daemon';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

let db: Database.Database; let checkout: string;
const now = new Date().toISOString();
const ON = { ACE_001_MODE: 'on', LOOP_SKILL_CARDS_ENABLED: 'true', LOOP_MEMORY_RULES_ENABLED: 'true' };
const blob = (v: number[]) => { const f = new Float32Array(v); return Buffer.from(f.buffer, f.byteOffset, f.byteLength); };
const proposal = (id: string, status: string, refs: string[], updated: string, artifact?: string) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
  VALUES (?, 'feature', ?, 'd', 'r', 'gap_analysis', ?, 0.5, ?, ?, ?, ?)`).run(id, `Add unit tests for ${id}`, status, JSON.stringify(refs), artifact ? JSON.stringify({ target: 'x', artifactPath: artifact }) : null, updated, updated);
const embedding = (id: string, v: number[]) => db.prepare('INSERT INTO proposal_embeddings (proposal_id, model, vector, created_at) VALUES (?, ?, ?, ?)').run(id, 'test', blob(v), now);
const kb = (p: string, v: number[], body = `body of ${p}`) => db.prepare('INSERT INTO kb_pages (path, host, title, body, sha, vector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(p, 'ws', `title ${p}`, body, createHash('sha256').update(body).digest('hex'), blob(v), now);
/** a goal id whose ACE-001 arm is `code` (deterministic search) */
const goalIn = (code: string) => { for (let i = 0; ; i++) if (aceArm(`goal-${i}`).code === code) return `goal-${i}`; };
const goal = (id: string, improvementId: string) => db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'running', '{}', ?, ?, ?)`).run(id, improvementId, now, now);
const test = (name: string) => { const p = `packages/server/src/__tests__/${name}.test.ts`; fs.writeFileSync(path.join(checkout, p), '// accepted'); return p; };

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  db.exec('CREATE TABLE IF NOT EXISTS proposal_embeddings (proposal_id TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS kb_pages (path TEXT PRIMARY KEY, host TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL)');
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-'));
  fs.mkdirSync(path.join(checkout, 'packages/server/src/__tests__'), { recursive: true });
  // recency picks recent-1 and recent-2 (newest); similarity picks `similar` (closest vector to the goal's proposal)
  proposal('recent-1', 'verified', ['test-gap:recent-1'], new Date(Date.now() - 1_000).toISOString(), test('recent-1')); embedding('recent-1', [0, 1, 0]);
  proposal('recent-2', 'verified', ['test-gap:recent-2'], new Date(Date.now() - 2_000).toISOString(), test('recent-2')); embedding('recent-2', [0, 0, 1]);
  proposal('similar', 'verified', ['test-gap:similar'], new Date(Date.now() - 86_400_000).toISOString(), test('similar')); embedding('similar', [1, 0.1, 0]);
  proposal('current', 'executing', ['test-gap:board'], now); embedding('current', [1, 0, 0]);
  kb('close.md', [0.9, 0.1, 0]); kb('far.md', [0, 0, 1]);
  db.prepare(`INSERT INTO memory_candidates (id, title, content, memory_type, status, promotion_status, human_required, sensitivity, metadata, created_at, updated_at, store)
    VALUES ('r1', 't', 'Restore the lockfile when only package-lock.json changed.', 'engineering_rule', 'promoted', 'promoted', 0, 'normal', '{}', ?, ?, 'procedural')`).run(now, now);
});
afterEach(() => { db.close(); fs.rmSync(checkout, { recursive: true, force: true }); });

it('arm assignment is deterministic per goal and balanced over goals', () => {
  expect(aceArm('g-x')).toEqual(aceArm('g-x'));
  const counts: Record<string, number> = { '00': 0, '01': 0, '10': 0, '11': 0 };
  for (let i = 0; i < 4000; i++) counts[aceArm(randomUUID()).code]++;
  for (const a of ACE_ARMS) expect(Math.abs(counts[a] - 1000)).toBeLessThan(120); // ~3.8 sd of a binomial(4000, 0.25)
});

it('off: the maker context is exactly today\'s (no ace field, recency examples, no KB)', () => {
  const g = goalIn('11'); goal(g, 'current');
  const ctx = assignmentContext(db, { id: 'run', goal_id: g }, checkout, 'maker', { ...ON, ACE_001_MODE: 'off' });
  expect(ctx.ace).toBeUndefined(); expect(ctx.kb).toBeUndefined();
  expect(ctx.examples.map((e) => e.split(' — ')[0])).toEqual([test('recent-1'), test('recent-2')]);
});

it('each arm injects its own context: S swaps recency for similarity, R adds the close KB page only', () => {
  const run = (code: string) => { const g = goalIn(code); proposal(`cur-${code}`, 'executing', ['test-gap:board'], now); embedding(`cur-${code}`, [1, 0, 0]); goal(g, `cur-${code}`); return assignmentContext(db, { id: `run-${code}`, goal_id: g }, checkout, `maker-${code}`, ON); };
  const a = run('00'); const s = run('01'); const r = run('10'); const rs = run('11');
  expect(a.ace).toMatchObject({ arm: '00', examples_source: 'recency', kb_paths: [] });
  expect(a.examples[0]).toContain('recent-1'); expect(a.kb).toBeUndefined();
  expect(s.ace).toMatchObject({ arm: '01', examples_source: 'similarity' }); expect(s.examples[0]).toContain('similar');
  expect(r.ace).toMatchObject({ arm: '10', examples_source: 'recency', kb_paths: ['close.md'] }); expect(r.examples[0]).toContain('recent-1');
  expect(rs.ace).toMatchObject({ arm: '11', examples_source: 'similarity', kb_paths: ['close.md'] });
  expect(assignmentContextMarkdown(rs).join('\n')).toContain('[kb:close.md]');
  expect(assignmentContextMarkdown(a).join('\n')).not.toContain('[kb:');
  // memory rules are the same in every arm (MEMORY_HOLDOUT stays its own, orthogonal randomisation)
  for (const c of [s, r, rs]) expect(c.rules.map((x) => x.id)).toEqual(a.rules.map((x) => x.id));
});

it('a goal without a stored proposal vector keeps the control context and records the fallback', () => {
  db.prepare("DELETE FROM proposal_embeddings WHERE proposal_id = 'current'").run();
  const g = goalIn('11'); goal(g, 'current');
  const ctx = assignmentContext(db, { id: 'run', goal_id: g }, checkout, 'maker', ON);
  expect(ctx.ace).toMatchObject({ arm: '11', examples_source: 'fallback_recency', kb_paths: [], fallback: ['s', 'r'] });
  expect(ctx.examples[0]).toContain('recent-1'); expect(ctx.kb).toBeUndefined();
});

it('non-oracle goals are not in the experiment', () => {
  proposal('reflect', 'executing', ['reflection:x'], now); const g = goalIn('11'); goal(g, 'reflect');
  expect(assignmentContext(db, { id: 'run', goal_id: g }, checkout, 'maker', ON).ace).toBeUndefined();
});

it('the gate set does not depend on the experiment', () => {
  const env = { LOOP_DAEMON_CHECK_SCRIPTS: 'test:changed,lint,type-check,test:mutation:grounded', LOOP_DAEMON_CHECK_TIMEOUT_MS: '300000' };
  expect(daemonCheckOptions({ ...env, ACE_001_MODE: 'on' })).toEqual(daemonCheckOptions(env));
});

it('evidence counts production outcomes per arm (gym outcomes and other refs excluded)', () => {
  new SkillEvolutionEngine(db); // creates skill_outcomes
  const outcome = (arm: string | null, success: boolean, skill = 'loop-maker:doc-drift-and-small-fix-loop:opencode', graded?: number) => db.prepare(`INSERT INTO skill_outcomes
      (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES (?, ?, ?, 1000, 1, 'x', ?, 'a', ?, ?)`)
    .run(randomUUID(), skill, success ? 1 : 0, randomUUID(), JSON.stringify([...(arm ? [`ace-001-arm:${arm}`] : []), ...(graded !== undefined ? [`graded:${graded}`] : [])]), now);
  outcome('00', true); outcome('00', false); outcome('11', true, undefined, 0.75); outcome('11', true, undefined, 0.25);
  outcome('01', true, 'loop-maker:gym:atomic'); outcome(null, true);
  const ev = ace001Evidence(db, new Date(Date.now() - 86_400_000).toISOString(), { ACE_001_MODE: 'on' });
  expect(ev.arms['00']).toMatchObject({ n: 2, verified: 1, verified_rate: 0.5, tokens_mean: 1000 });
  expect(ev.arms['11']).toMatchObject({ n: 2, verified: 2, graded_n: 2, graded_mean: 0.5 });
  expect(ev.arms['01'].n).toBe(0); expect(ev.status).toBe('collecting');
  expect(ev.main_effects.retrieval).toMatchObject({ on_n: 2, off_n: 2, diff: 0.5 });
  expect(buildEvolutionEvidence(db, { ACE_001_MODE: 'on' }).ace_001.arms['11'].n).toBe(2);
});
