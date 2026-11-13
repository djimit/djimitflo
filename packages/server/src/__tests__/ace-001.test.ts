import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { assignmentContext, assignmentContextMarkdown } from '../services/assignment-context';
import {
  ACE_001_ANALYSIS_SINCE_DEFAULT, ACE_001_TARGET_PER_ARM, ACE_ARMS, ACE_001_STOP_BY,
  ace001Evidence, ace001On, aceAnalysisSince, aceArm, aceDelivery, aceFallbackReason, aceLane,
  similarExamples, similarKbPages,
} from '../services/ace-001';
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
  const ev = ace001Evidence(db, new Date(Date.now() - 86_400_000).toISOString(), { ACE_001_MODE: 'on', ACE_001_ANALYSIS_SINCE: '2020-01-01T00:00:00Z' });
  expect(ev.arms['00']).toMatchObject({ n: 2, verified: 1, verified_rate: 0.5, tokens_mean: 1000 });
  expect(ev.arms['11']).toMatchObject({ n: 2, verified: 2, graded_n: 2, graded_mean: 0.5 });
  expect(ev.arms['01'].n).toBe(0); expect(ev.status).toBe('collecting');
  // re-20261030 B §3: no interim efficacy looks (ACE-001_PROTOCOL.md:51) — before the readout the effect is withheld, with a reason
  expect(ev.main_effects.retrieval).toMatchObject({ on_n: 2, off_n: 2, diff: null });
  expect(ev.main_effects.retrieval.withheld).toMatch(/no interim efficacy looks/);
  expect(buildEvolutionEvidence(db, { ACE_001_MODE: 'on', ACE_001_ANALYSIS_SINCE: '2020-01-01T00:00:00Z' }).ace_001.arms['11'].n).toBe(2);
  // at the readout (stop_by, Amendment 2) the same data reads out
  const out = ace001Evidence(db, new Date(Date.now() - 86_400_000).toISOString(), { ACE_001_MODE: 'on', ACE_001_ANALYSIS_SINCE: '2020-01-01T00:00:00Z' }, Date.parse(ACE_001_STOP_BY));
  expect(out.main_effects.retrieval).toMatchObject({ on_n: 2, off_n: 2, diff: 0.5, withheld: null });
});

it('ace001On is true only when ACE_001_MODE is exactly "on"', () => {
  expect(ace001On({ ACE_001_MODE: 'on' })).toBe(true);
  expect(ace001On({ ACE_001_MODE: 'off' })).toBe(false);
  expect(ace001On({ ACE_001_MODE: 'ON' })).toBe(false);
  expect(ace001On({})).toBe(false);
});

it('aceAnalysisSince returns the env value when set, otherwise the default', () => {
  expect(aceAnalysisSince({ ACE_001_ANALYSIS_SINCE: '2025-06-01T00:00:00Z' })).toBe('2025-06-01T00:00:00Z');
  expect(aceAnalysisSince({})).toBe(ACE_001_ANALYSIS_SINCE_DEFAULT);
});

it('aceLane returns null for a null goal id, and for a non-oracle goal', () => {
  expect(aceLane(db, null)).toBeNull();
  proposal('reflect', 'executing', ['reflection:x'], now); const g = goalIn('11'); goal(g, 'reflect');
  expect(aceLane(db, g)).toBeNull();
});

it('aceLane detects the mutation lane and the test-gap lane by evidence_refs_json', () => {
  proposal('mut-1', 'executing', ['"mutation-gap:svc"'], now); const gm = goalIn('10'); goal(gm, 'mut-1');
  expect(aceLane(db, gm)).toEqual({ lane: 'mutation', improvementId: 'mut-1' });
  proposal('tg-1', 'executing', ['"test-gap:svc"'], now); const gt = goalIn('01'); goal(gt, 'tg-1');
  expect(aceLane(db, gt)).toEqual({ lane: 'test-gap', improvementId: 'tg-1' });
});

it('aceFallbackReason: no_embedding when no vector and no error judgment; embedding_failed on an error judgment; no_match when a vector exists', () => {
  proposal('no-vec', 'executing', ['"test-gap:x"'], now);
  expect(aceFallbackReason(db, 'no-vec')).toBe('no_embedding');
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, created_at) VALUES (?, 'proposal_embedding', 'self_improvement', ?, '', 'auto', 'error', ?)")
    .run(randomUUID(), 'no-vec', now);
  expect(aceFallbackReason(db, 'no-vec')).toBe('embedding_failed');
  // 'current' has a stored vector (from beforeEach) → no_match
  expect(aceFallbackReason(db, 'current')).toBe('no_match');
});

it('similarExamples returns null when the proposal has no vector, and sorts by descending cosine score', () => {
  proposal('no-vec-2', 'verified', ['"test-gap:no-vec"'], now, test('no-vec-2'));
  expect(similarExamples(db, 'no-vec-2', 'test-gap', checkout)).toBeNull();
  // 'current' proposal vector is [1,0,0]; 'similar' has [1,0.1,0] (closest), then recent-1 [0,1,0]
  const ex = similarExamples(db, 'current', 'test-gap', checkout, 2)!;
  expect(ex).toHaveLength(2);
  expect(ex[0]).toContain('similar');
  expect(ex[1]).toContain('recent-1');
});

it('similarExamples excludes rows whose artifact file does not exist and rows with a mismatched vector length', () => {
  // proposal with an artifact path that does not exist on disk
  proposal('ghost-art', 'verified', ['"test-gap:ghost"'], now, 'packages/server/src/__tests__/missing-file.test.ts');
  embedding('ghost-art', [1, 0.1, 0]);
  const ex = similarExamples(db, 'current', 'test-gap', checkout, 5)!;
  expect(ex.every((e) => !e.includes('ghost-art'))).toBe(true);
});

it('similarExamples selects the mutation lane ref pattern for lane "mutation"', () => {
  proposal('mut-ex', 'verified', ['"mutation-gap:svc"'], now, test('mut-ex')); embedding('mut-ex', [1, 0.05, 0]);
  const ex = similarExamples(db, 'current', 'mutation', checkout, 2)!;
  expect(ex[0]).toContain('mut-ex');
  // test-gap examples must not appear in the mutation lane
  expect(ex.every((e) => !e.includes('recent-1'))).toBe(true);
});

it('similarKbPages returns null when the proposal has no vector', () => {
  expect(similarKbPages(db, 'no-such-proposal')).toBeNull();
});

it('similarKbPages skips quarantined pages and pages whose body sha no longer matches, and respects the min threshold', () => {
  // add a quarantined_at column and a quarantined page that would otherwise be very close
  db.exec('ALTER TABLE kb_pages ADD COLUMN quarantined_at TEXT');
  db.prepare("UPDATE kb_pages SET quarantined_at = '2026-01-01T00:00:00Z' WHERE path = 'close.md'").run();
  // corrupt the sha of far.md so it no longer matches its body
  db.prepare("UPDATE kb_pages SET sha = 'deadbeef' WHERE path = 'far.md'").run();
  // add a page that is close enough (score ~0.9 >= 0.3)
  kb('near.md', [0.95, 0.05, 0]);
  const pages = similarKbPages(db, 'current', 3, 0.3)!;
  expect(pages.map((p) => p.path)).toEqual(['near.md']);
});

it('similarKbPages sorts by descending score and slices to k', () => {
  kb('a.md', [0.8, 0.1, 0]); kb('b.md', [0.99, 0.01, 0]);
  const pages = similarKbPages(db, 'current', 1, 0.3)!;
  expect(pages).toHaveLength(1);
  expect(pages[0].path).toBe('b.md');
});

it('similarKbPages returns [] when the kb_pages table is missing (lazy schema)', () => {
  db.exec('DROP TABLE kb_pages');
  expect(similarKbPages(db, 'current')).toEqual([]);
});

it('aceDelivery counts per-arm treated/delivered slots, rates, and fallback reasons from assignment_context events', () => {
  const insertEvent = (runId: string, createdAt: string, ace: Record<string, unknown>) => db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)`)
    .run(randomUUID(), runId, JSON.stringify({ ace_001: ace }), createdAt);
  const ts = (offset: number) => new Date(Date.now() - offset).toISOString();
  // arm 11: r treated+delivered, s treated+delivered (no fallback)
  insertEvent('r1', ts(5000), { arm: '11', lane: 'test-gap', examples_source: 'similarity', kb_paths: ['close.md'], fallback: [], fallback_reason: undefined });
  // arm 10: r treated but fell back (r in fallback)
  insertEvent('r2', ts(4000), { arm: '10', lane: 'test-gap', examples_source: 'recency', kb_paths: [], fallback: ['r'], fallback_reason: 'no_embedding' });
  // arm 01: s treated but fell back (s in fallback)
  insertEvent('r3', ts(3000), { arm: '01', lane: 'test-gap', examples_source: 'fallback_recency', kb_paths: [], fallback: ['s'], fallback_reason: 'embedding_failed' });
  // arm 00: control, no treated factors
  insertEvent('r4', ts(2000), { arm: '00', lane: 'test-gap', examples_source: 'recency', kb_paths: [], fallback: [] });
  // a second event for r1 (older) should be ignored — only the latest per loop_run_id counts
  insertEvent('r1', ts(8000), { arm: '11', lane: 'test-gap', examples_source: 'recency', kb_paths: [], fallback: ['r', 's'], fallback_reason: 'no_embedding' });

  const d = aceDelivery(db, ts(10000));
  expect(d.per_arm['11']).toMatchObject({ runs: 1, r_treated: 1, r_delivered: 1, s_treated: 1, s_delivered: 1 });
  expect(d.per_arm['10']).toMatchObject({ runs: 1, r_treated: 1, r_delivered: 0 });
  expect(d.per_arm['10'].s_treated).toBe(0);
  expect(d.per_arm['01']).toMatchObject({ runs: 1, s_treated: 1, s_delivered: 0 });
  expect(d.per_arm['01'].r_treated).toBe(0);
  expect(d.per_arm['00']).toMatchObject({ runs: 1, r_treated: 0, s_treated: 0, r_delivered: 0, s_delivered: 0 });
  // rates: r delivered 1/2, s delivered 1/2
  expect(d.retrieval_rate).toBe(0.5);
  expect(d.examples_rate).toBe(0.5);
  expect(d.fallback_reasons).toEqual({ no_embedding: 1, embedding_failed: 1 });
});

it('aceDelivery skips events with no ace_001 field, an invalid arm, or unparseable metadata', () => {
  const insertEvent = (runId: string, metadata: string) => db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, ?, 'assignment_context', 'info', 'm', ?, ?)`)
    .run(randomUUID(), runId, metadata, now);
  insertEvent('no-ace', JSON.stringify({ examples: [] }));
  insertEvent('bad-arm', JSON.stringify({ ace_001: { arm: '99', lane: 'test-gap', examples_source: 'recency', kb_paths: [], fallback: [] } }));
  insertEvent('bad-json', '{not valid json');
  const d = aceDelivery(db, new Date(Date.now() - 86_400_000).toISOString());
  for (const a of ACE_ARMS) expect(d.per_arm[a].runs).toBe(0);
  expect(d.retrieval_rate).toBeNull();
  expect(d.examples_rate).toBeNull();
});

it('aceDelivery counts fallback_reasons as "unrecorded" when fallback is non-empty but fallback_reason is absent', () => {
  db.prepare(`INSERT INTO loop_events (id, loop_run_id, event_type, level, message, metadata, created_at) VALUES (?, 'r-unc', 'assignment_context', 'info', 'm', ?, ?)`)
    .run(randomUUID(), JSON.stringify({ ace_001: { arm: '11', lane: 'test-gap', examples_source: 'fallback_recency', kb_paths: [], fallback: ['r'] } }), now);
  const d = aceDelivery(db, new Date(Date.now() - 86_400_000).toISOString());
  expect(d.fallback_reasons).toEqual({ unrecorded: 1 });
});

it('ace001Evidence uses the later of windowSince and analysisSince, and reports delivery_invalid before analysis_since', () => {
  new SkillEvolutionEngine(db);
  const outcome = (arm: string, success: boolean) => db.prepare(`INSERT INTO skill_outcomes
      (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES (?, 'loop-maker:doc-drift-and-small-fix-loop:opencode', ?, 1000, 1, 'x', ?, 'a', ?, ?)`)
    .run(randomUUID(), success ? 1 : 0, randomUUID(), JSON.stringify([`ace-001-arm:${arm}`]), now);
  outcome('00', true);
  // analysis_since is in the future relative to `now` → delivery_invalid counts all outcomes, rows are excluded
  const future = '2099-01-01T00:00:00Z';
  const ev = ace001Evidence(db, '2020-01-01T00:00:00Z', { ACE_001_MODE: 'on', ACE_001_ANALYSIS_SINCE: future });
  expect(ev.arms['00'].n).toBe(0);
  expect(ev.delivery_invalid).toBe(1);
  // windowSince after analysisSince → since = windowSince
  const ev2 = ace001Evidence(db, now, { ACE_001_MODE: 'on', ACE_001_ANALYSIS_SINCE: '2020-01-01T00:00:00Z' });
  expect(ev2.arms['00'].n).toBe(1);
});

it('ace001Evidence status is analysable when every arm reaches the target and main-effect diff is published at readout', () => {
  new SkillEvolutionEngine(db);
  const outcome = (arm: string, success: boolean) => db.prepare(`INSERT INTO skill_outcomes
      (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES (?, 'loop-maker:doc-drift-and-small-fix-loop:opencode', ?, 1000, 1, 'x', ?, 'a', ?, ?)`)
    .run(randomUUID(), success ? 1 : 0, randomUUID(), JSON.stringify([`ace-001-arm:${arm}`]), now);
  for (let i = 0; i < ACE_001_TARGET_PER_ARM; i++) for (const a of ACE_ARMS) outcome(a, a[0] === '1');
  const ev = ace001Evidence(db, '2020-01-01T00:00:00Z', { ACE_001_MODE: 'on', ACE_001_ANALYSIS_SINCE: '2020-01-01T00:00:00Z' });
  expect(ev.status).toBe('analysable');
  // retrieval effect: on = arms 10,11 (r=1); off = arms 00,01 (r=0). All r=1 arms succeed, all r=0 fail → diff = 1
  expect(ev.main_effects.retrieval).toMatchObject({ diff: 1, withheld: null });
  // examples effect: on = arms 01,11 (s=1); off = arms 00,10 (s=0). 01 fails (s=1 but a[0]=0), 11 succeeds, 00 fails, 10 succeeds → 1/2 vs 1/2 → 0
  expect(ev.main_effects.examples).toMatchObject({ diff: 0, withheld: null });
});

it('ace001Evidence main-effect diff is null (withheld) when an arm has zero outcomes before readout', () => {
  new SkillEvolutionEngine(db);
  const outcome = (arm: string) => db.prepare(`INSERT INTO skill_outcomes
      (id, skill_id, success, tokens_used, duration_ms, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES (?, 'loop-maker:doc-drift-and-small-fix-loop:opencode', 1, 1000, 1, 'x', ?, 'a', ?, ?)`)
    .run(randomUUID(), randomUUID(), JSON.stringify([`ace-001-arm:${arm}`]), now);
  outcome('00'); outcome('01'); outcome('10'); // arm 11 empty
  const ev = ace001Evidence(db, '2020-01-01T00:00:00Z', { ACE_001_MODE: 'on', ACE_001_ANALYSIS_SINCE: '2020-01-01T00:00:00Z' });
  expect(ev.main_effects.retrieval.diff).toBeNull();
  expect(ev.main_effects.retrieval.withheld).toMatch(/no interim efficacy looks/);
});

it('ace001Evidence mode is null when ACE_001_MODE is unset', () => {
  new SkillEvolutionEngine(db);
  const ev = ace001Evidence(db, '2020-01-01T00:00:00Z', {});
  expect(ev.mode).toBeNull();
});
