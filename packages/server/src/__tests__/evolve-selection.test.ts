import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evolveEligible, evolveSpecies, mutationScoreOf, selectEvolveWinner } from '../services/evolve-selection';
import { LoopService } from '../services/loop-service';

let db: Database.Database;
const now = new Date().toISOString();
const maker = (id: string, runtime: string, meta: object) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'run-1', 'maker', ?, 'completed', ?, ?, ?)`)
  .run(id, runtime, JSON.stringify(meta), now, now);
const reviewer = (id: string, role: string, makerId: string) => db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'run-1', ?, 'manual', 'prepared', ?, ?, ?)`)
  .run(id, role, JSON.stringify({ maker_lease_id: makerId }), now, now);
const meta = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata);
const status = (id: string) => (db.prepare('SELECT status FROM worker_leases WHERE id = ?').get(id) as { status: string }).status;
const ok = (diff: number, extra: object = {}) => ({ exit_status: 0, deterministic_checks: [{ name: 'test', status: 'pass' }], diff_lines: diff, diff_max_lines: 200, completed_at: now, ...extra });

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('run-1', 'doc-drift-and-small-fix-loop', 'closed', 'running', '[]', ?, ?)`).run(now, now);
});
afterEach(() => db.close());

it('species come from LOOP_EVOLVE_SPECIES only when enabled, at most two extra makers', () => {
  expect(evolveSpecies({ LOOP_EVOLVE_SPECIES: 'codex' })).toEqual([]);
  expect(evolveSpecies({ LOOP_EVOLVE_ENABLED: 'true', LOOP_EVOLVE_SPECIES: 'opencode@ollama/kimi-k2.6:cloud, codex, pi' }))
    .toEqual([{ runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud' }, { runtime: 'codex' }]);
});

it('only test-gap goals (or goals marked evolve) are eligible', () => {
  const si = (id: string, refs: string[]) => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', 'executing', 0.5, ?, ?, ?)`).run(id, JSON.stringify(refs), now, now);
  const goal = (id: string, improvementId: string | null, metadata: object = {}) => db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'running', ?, ?, ?, ?)`).run(id, JSON.stringify(metadata), improvementId, now, now);
  si('p-tg', ['test-gap:board-protocol']); si('p-other', ['reflection:x']); si('p-mut', ['mutation-gap:secret-patterns']);
  goal('g-tg', 'p-tg'); goal('g-other', 'p-other'); goal('g-flag', null, { evolve: true }); goal('g-mut', 'p-mut');
  expect([evolveEligible(db, 'g-tg'), evolveEligible(db, 'g-other'), evolveEligible(db, 'g-flag'), evolveEligible(db, 'g-mut')]).toEqual([true, false, true, true]);
});

it('the fittest maker stays the only non-superseded one; losers are superseded and their reviewers cancelled', () => {
  maker('m-a', 'opencode', ok(80, { superseded_by_maker_lease_id: 'm-b' })); reviewer('c-a', 'checker', 'm-a'); reviewer('s-a', 'security_checker', 'm-a');
  maker('m-b', 'opencode', ok(40, { model: 'ollama/kimi-k2.6:cloud' })); reviewer('c-b', 'checker', 'm-b');
  maker('m-c', 'codex', { ...ok(10), exit_status: 1 }); reviewer('c-c', 'checker', 'm-c'); // smallest diff, but failed: not eligible

  expect(selectEvolveWinner(db, 'run-1', ['m-a', 'm-b', 'm-c'])).toBe('m-b');
  expect(meta('m-b').superseded_by_maker_lease_id).toBeUndefined();
  expect(meta('m-b').evolve).toMatchObject({ rank: 1, species: 'opencode@ollama/kimi-k2.6:cloud', reason: 'winner' });
  expect(meta('m-a').superseded_by_maker_lease_id).toBe('m-b');
  expect(meta('m-c').evolve.reason).toBe('runtime exit != 0');
  expect([status('c-a'), status('s-a'), status('c-c'), status('c-b')]).toEqual(['cancelled', 'cancelled', 'cancelled', 'prepared']);
  expect(db.prepare("SELECT event_type FROM loop_events WHERE loop_run_id = 'run-1'").all()).toEqual([{ event_type: 'evolve_selected' }]);
});

it('a maker that did not touch the goal\'s artifact cannot win, however small its diff (prod 2026-10-01: README edit beat the test)', () => {
  const test = 'packages/server/src/__tests__/runtime-bandit.exports.test.ts';
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
    VALUES ('p-1', 'feature', 't', 'd', 'r', 'gap_analysis', 'executing', 0.5, '["test-gap:runtime-bandit#exports"]', ?, ?, ?)`).run(JSON.stringify({ artifactPath: test }), now, now);
  db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES ('g-1', 'o', 'low', 'running', '{}', 'p-1', ?, ?)`).run(now, now);
  db.prepare("UPDATE loop_runs SET goal_id = 'g-1' WHERE id = 'run-1'").run();
  maker('m-test', 'opencode', ok(32, { changed_files: [test] })); reviewer('c-test', 'checker', 'm-test');
  maker('m-docs', 'opencode', ok(26, { changed_files: ['CONTRIBUTING.md', 'README.md'] })); reviewer('c-docs', 'checker', 'm-docs');
  expect(selectEvolveWinner(db, 'run-1', ['m-test', 'm-docs'])).toBe('m-test');
  expect(meta('m-docs').evolve.reason).toBe('over budget or disallowed paths');
  expect([status('c-test'), status('c-docs')]).toEqual(['prepared', 'cancelled']);
});

it('no eligible maker: nothing changes and the run fails like a single-maker run', () => {
  maker('m-a', 'opencode', { exit_status: 1 }); reviewer('c-a', 'checker', 'm-a');
  expect(selectEvolveWinner(db, 'run-1', ['m-a'])).toBeNull();
  expect(status('c-a')).toBe('prepared');
  expect(db.prepare("SELECT event_type FROM loop_events WHERE loop_run_id = 'run-1'").get()).toEqual({ event_type: 'evolve_no_winner' });
});

it('N7: losing species are recorded as outcomes, and a measured mutation score outranks a smaller diff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-'));
  const out = (score: number) => { const f = path.join(dir, `${score}.log`); fs.writeFileSync(f, `{"mutation_gain":{"before":30,"after":${score},"pass":true}}\n`); return f; };
  const mut = (diff: number, score: number, extra: object = {}) => ok(diff, { deterministic_checks: [{ name: 'test', status: 'pass' }, { name: 'test:mutation:grounded', status: 'pass', stdout_path: out(score) }], ...extra });
  maker('m-small', 'opencode', mut(10, 45)); maker('m-strong', 'codex', mut(60, 70, { model: 'gpt-5' }));
  expect(selectEvolveWinner(db, 'run-1', ['m-small', 'm-strong'])).toBe('m-strong');
  expect(db.prepare('SELECT skill_id, success, agent_id FROM skill_outcomes').all()).toEqual([{ skill_id: 'loop-maker:doc-drift-and-small-fix-loop:opencode', success: 0, agent_id: 'm-small' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

it('a loser that never finished (still prepared) is not recorded as a lost outcome', () => {
  maker('m-done', 'opencode', ok(20));
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('m-pending', 'run-1', 'maker', 'opencode', 'prepared', '{"model":"kimi"}', ?, ?)`).run(now, now);
  expect(selectEvolveWinner(db, 'run-1', ['m-done', 'm-pending'])).toBe('m-done');
  expect(db.prepare('SELECT COUNT(*) AS n FROM skill_outcomes').get()).toEqual({ n: 0 });
});

it('D0: a measured mutation score of 0 stays 0 (it used to become null = not measured)', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mut-')), 'out.json');
  fs.writeFileSync(f, '{"before":0,"after":0}');
  expect(mutationScoreOf([{ name: 'test:mutation:grounded', stdout_path: f }])).toBe(0);
  fs.writeFileSync(f, 'no json line');
  expect(mutationScoreOf([{ name: 'test:mutation:grounded', stdout_path: f }])).toBeNull();
});

it('RX-3: an evolve loser that was eligible (lost on rank) is tagged, an ineligible one too, so the reward can tell them apart', () => {
  maker('m-a', 'opencode', ok(80)); reviewer('c-a', 'checker', 'm-a');
  maker('m-b', 'codex', ok(40)); reviewer('c-b', 'checker', 'm-b');
  maker('m-c', 'pi', { ...ok(10), exit_status: 1 }); reviewer('c-c', 'checker', 'm-c');
  expect(selectEvolveWinner(db, 'run-1', ['m-a', 'm-b', 'm-c'])).toBe('m-b');
  const refs = (agent: string) => JSON.parse((db.prepare('SELECT evidence_refs_json AS r FROM skill_outcomes WHERE agent_id = ?').get(agent) as { r: string }).r) as string[];
  expect(refs('m-a')).toContain('evolve:lost_eligible');
  expect(refs('m-c')).toContain('evolve:lost_ineligible');
});

describe('SI-B graded contest (GRADED_CONTEST_MODE)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const refs = (agent: string) => JSON.parse((db.prepare('SELECT evidence_refs_json AS r FROM skill_outcomes WHERE agent_id = ?').get(agent) as { r: string }).r) as string[];
  const outcome = (agent: string) => db.prepare('SELECT success FROM skill_outcomes WHERE agent_id = ?').get(agent) as { success: number } | undefined;
  const graded = (score: number) => ({ graded: { score, kind: 'mutant_kill', lane: 'test-gap', killed: Math.round(score * 3), total: 3 } });
  // the current rule picks m-small (smaller diff); graded picks m-strong (kills 3/3 vs 1/3); m-bad failed its checks
  const seedContest = () => {
    maker('m-small', 'opencode', ok(30, graded(1 / 3))); reviewer('c-small', 'checker', 'm-small');
    maker('m-strong', 'codex', ok(80, { ...graded(1), model: 'gpt-5' })); reviewer('c-strong', 'checker', 'm-strong');
    maker('m-bad', 'pi', { ...ok(10, graded(1)), deterministic_checks: [{ name: 'test', status: 'fail' }] }); reviewer('c-bad', 'checker', 'm-bad');
  };
  const contestEvent = () => db.prepare("SELECT metadata FROM loop_events WHERE loop_run_id = 'run-1' AND event_type = 'contest_graded'").get() as { metadata: string } | undefined;

  it('off: no contest event, losers as before (success 0), graded refs ride along on the loser outcomes', () => {
    seedContest();
    expect(selectEvolveWinner(db, 'run-1', ['m-small', 'm-strong', 'm-bad'])).toBe('m-small');
    expect(contestEvent()).toBeUndefined();
    expect(outcome('m-strong')).toEqual({ success: 0 });
    expect(refs('m-strong')).toEqual(expect.arrayContaining(['evolve:lost_eligible', 'graded:1.000', 'graded_kind:mutant_kill', 'graded_lane:test-gap']));
  });

  it('shadow: logs contest_graded {current_winner, graded_winner, scores, agree}; nothing changes', () => {
    vi.stubEnv('GRADED_CONTEST_MODE', 'shadow');
    seedContest();
    expect(selectEvolveWinner(db, 'run-1', ['m-small', 'm-strong', 'm-bad'])).toBe('m-small');
    const ev = JSON.parse(contestEvent()!.metadata);
    expect(ev).toEqual({ current_winner: 'm-small', graded_winner: 'm-strong', scores: { 'm-small': 0.333, 'm-strong': 1 }, agree: false });
    expect(meta('m-strong').superseded_by_maker_lease_id).toBe('m-small');
    expect([status('c-small'), status('c-strong')]).toEqual(['prepared', 'cancelled']);
    expect(outcome('m-strong')).toEqual({ success: 0 });
    expect(refs('m-strong')).toContain('evolve:lost_eligible');
  });

  it('shadow: fewer than two gate-passing makers is no contest', () => {
    vi.stubEnv('GRADED_CONTEST_MODE', 'shadow');
    maker('m-small', 'opencode', ok(30, graded(1 / 3)));
    maker('m-bad', 'pi', { ...ok(10, graded(1)), exit_status: 1 });
    expect(selectEvolveWinner(db, 'run-1', ['m-small', 'm-bad'])).toBe('m-small');
    expect(contestEvent()).toBeUndefined();
  });

  it('shadow: a tie (or no graded score) keeps the current rule and agrees', () => {
    vi.stubEnv('GRADED_CONTEST_MODE', 'shadow');
    maker('m-small', 'opencode', ok(30, graded(1))); maker('m-big', 'codex', ok(80, graded(1))); maker('m-none', 'pi', ok(50));
    expect(selectEvolveWinner(db, 'run-1', ['m-big', 'm-none', 'm-small'])).toBe('m-small');
    expect(JSON.parse(contestEvent()!.metadata)).toMatchObject({ current_winner: 'm-small', graded_winner: 'm-small', agree: true, scores: { 'm-small': 1, 'm-big': 1, 'm-none': null } });
  });

  it('act: the graded winner wins; a gate-passing loser is success=1 with contest:passed_lost; a failed one stays success=0', () => {
    vi.stubEnv('GRADED_CONTEST_MODE', 'act');
    seedContest();
    expect(selectEvolveWinner(db, 'run-1', ['m-small', 'm-strong', 'm-bad'])).toBe('m-strong');
    expect(meta('m-strong').superseded_by_maker_lease_id).toBeUndefined();
    expect(meta('m-small').superseded_by_maker_lease_id).toBe('m-strong');
    expect([status('c-strong'), status('c-small'), status('c-bad')]).toEqual(['prepared', 'cancelled', 'cancelled']);
    expect(outcome('m-small')).toEqual({ success: 1 });
    expect(refs('m-small')).toEqual(expect.arrayContaining(['contest:passed_lost', 'evolve:lost_to:codex@gpt-5', 'graded:0.333']));
    expect(refs('m-small')).not.toContain('evolve:lost_eligible');
    expect(outcome('m-bad')).toEqual({ success: 0 });
    expect(refs('m-bad')).toContain('evolve:lost_ineligible');
    expect(refs('m-bad')).not.toContain('contest:passed_lost');
    expect(outcome('m-strong')).toBeUndefined(); // the winner's own outcome is the daemon's (9a'')
    expect(JSON.parse(contestEvent()!.metadata)).toMatchObject({ current_winner: 'm-small', graded_winner: 'm-strong', agree: false });
  });
});

it('prod 2026-10-09 run 161f7840: a retry maker still prepared when the winner is chosen is superseded, so maker_completion judges the winner only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-leftover-'));
  const loops = new LoopService(db, path.join(root, 'evidence'));
  const worktree = path.join(root, 'wt'); fs.mkdirSync(worktree); fs.writeFileSync(path.join(worktree, 'LOOP_WORK.md'), 'assignment');
  db.prepare("UPDATE loop_runs SET repository_path = ?, findings_json = '[]', metadata = '{}' WHERE id = 'run-1'").run(root);
  // the first maker failed its checks; retryLoopRun made a retry (whose execution never got going) and then the evolve sibling
  maker('m-first', 'opencode', { exit_status: 1, superseded_by_maker_lease_id: 'm-sib' }); reviewer('c-first', 'checker', 'm-first');
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('m-retry', 'run-1', 'maker', 'opencode', 'prepared', ?, ?, ?)`)
    .run(JSON.stringify({ retry_of_maker_lease_id: 'm-first', retry_attempt: 1 }), now, now);
  reviewer('c-retry', 'checker', 'm-retry'); reviewer('s-retry', 'security_checker', 'm-retry');
  maker('m-sib', 'remote', ok(30, { retry_of_maker_lease_id: 'm-first', evolve_sibling_of: 'm-first', retry_attempt: 2, assignment_file: path.join(worktree, 'LOOP_WORK.md') }));
  db.prepare("UPDATE worker_leases SET worktree_path = ? WHERE id = 'm-sib'").run(worktree);
  reviewer('c-sib', 'checker', 'm-sib');

  expect(selectEvolveWinner(db, 'run-1', ['m-first', 'm-sib'])).toBe('m-sib');
  expect(loops.verifyLoopRun('run-1').gates.find((g) => g.name === 'maker_completion')).toMatchObject({ status: 'pass', evidence: expect.stringMatching(/^1\/1 /) });
  expect(meta('m-retry')).toMatchObject({ superseded_by_maker_lease_id: 'm-sib', cancellation_reason: 'superseded_by_evolve_winner' });
  expect([status('m-retry'), status('c-retry'), status('s-retry'), status('c-sib')]).toEqual(['cancelled', 'cancelled', 'cancelled', 'prepared']);
  fs.rmSync(root, { recursive: true, force: true });
});

it('a maker of the run that is already running when the winner is chosen is left alone', () => {
  maker('m-a', 'opencode', ok(20)); maker('m-b', 'codex', ok(40));
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('m-run', 'run-1', 'maker', 'opencode', 'running', '{}', ?, ?)`).run(now, now);
  expect(selectEvolveWinner(db, 'run-1', ['m-a', 'm-b'])).toBe('m-a');
  expect([status('m-run'), meta('m-run').superseded_by_maker_lease_id]).toEqual(['running', undefined]);
});
