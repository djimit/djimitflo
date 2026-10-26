import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { autoRequeueTick } from '../services/auto-requeue';
import { decisionsInbox, dismissRequeue } from '../services/decisions-inbox';
import { operatorCockpit } from '../services/operator-cockpit';
import { requeueImprovement } from '../services/improvement-requeue';
import {
  AUTO_REQUEUE_ACTOR, autoRequeueMaxPerTick, autoRequeueMode, makerGateMet, requeueOutcomesByClass, targetFile, type RequeueOutcomes,
} from '../services/requeue-policy';

let db: Database.Database;
const NOW = Date.now();
const iso = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF'); });
afterEach(() => db.close());

const seed = (id: string, status: string, o: { refs?: string[]; age?: number; grounding?: Record<string, unknown>; title?: string } = {}) => db.prepare(`INSERT INTO self_improvements
  (id, type, title, description, rationale, source, status, evidence_refs_json, grounding_json, created_at, updated_at) VALUES (?, 'test', ?, 'd', 'r', 'gap_analysis', ?, ?, ?, ?, ?)`)
  .run(id, o.title ?? `title ${id}`, status, JSON.stringify(o.refs ?? []), o.grounding ? JSON.stringify(o.grounding) : null, iso((o.age ?? 1) + 1), iso(o.age ?? 1));
const attribute = (id: string, decision: string) => db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
  VALUES (?, 'outcome_attribution', 'self_improvement', ?, 'h', 'annotation', ?, 't', ?)`).run(`a-${id}`, id, decision, iso(0));
const copies = (of: string) => (db.prepare(`SELECT id, approved_by, evidence_refs_json FROM self_improvements WHERE evidence_refs_json LIKE ?`).all(`%"requeue-of:${of}"%`) as Array<{ id: string; approved_by: string; evidence_refs_json: string }>);
const judgments = (j: string) => db.prepare('SELECT subject_id, mode, decision, reason, state_hash FROM judgments WHERE judgment = ? ORDER BY subject_id').all(j) as Array<{ subject_id: string; mode: string; decision: string; reason: string; state_hash: string }>;
const rowCount = () => (db.prepare('SELECT (SELECT COUNT(*) FROM self_improvements) + (SELECT COUNT(*) FROM judgments) AS n').get() as { n: number }).n;
const ON = { REQUEUE_AUTO_MODE: 'on' } as NodeJS.ProcessEnv;
const SHADOW = { REQUEUE_AUTO_MODE: 'shadow' } as NodeJS.ProcessEnv;
const onMain = { targetOnMain: () => true as const, outcomes: null };
/** a measured maker_failure history: `verified` of `n` settled requeue copies verified */
const makerHistory = (verified: number, n: number) => {
  for (let i = 0; i < n; i++) {
    seed(`h${i}`, 'regressed', { age: 60 }); attribute(`h${i}`, 'maker_failure');
    seed(`hc${i}`, i < verified ? 'verified' : 'regressed', { age: 60, refs: [`requeue-of:h${i}`] });
  }
};

describe('flags', () => {
  it('REQUEUE_AUTO_MODE defaults to off and accepts only shadow / on; the per-tick cap defaults to 3', () => {
    expect([undefined, '', 'yes', 'ON', 'shadow', 'on'].map((v) => autoRequeueMode({ REQUEUE_AUTO_MODE: v } as NodeJS.ProcessEnv))).toEqual(['off', 'off', 'off', 'on', 'shadow', 'on']);
    expect([undefined, '0', '-2', '5', '99'].map((v) => autoRequeueMaxPerTick({ REQUEUE_AUTO_MAX_PER_TICK: v } as NodeJS.ProcessEnv))).toEqual([3, 3, 3, 5, 20]);
  });
});

describe('measurement', () => {
  it('stratifies settled requeue copies by the original class; the maker gate needs ≥ 40 % with n ≥ 10', () => {
    seed('e', 'regressed', { age: 40 }); attribute('e', 'environment_failure'); seed('ec', 'verified', { age: 40, refs: ['requeue-of:e'] });
    seed('r', 'regressed', { age: 40 }); attribute('r', 'reviewer_failure'); seed('rc', 'executing', { age: 40, refs: ['requeue-of:r'] });
    seed('n', 'no_change', { age: 40 }); seed('nc', 'no_change', { age: 40, refs: ['requeue-of:n'] });
    seed('u', 'infra_failed', { age: 40 }); seed('uc', 'verified', { age: 40, refs: ['requeue-of:u'] });
    makerHistory(4, 10);
    const m = requeueOutcomesByClass(db)!;
    expect(m.environment_failure).toEqual({ copies: 1, settled: 1, verified: 1, rate: 1 });
    expect(m.reviewer_failure).toEqual({ copies: 1, settled: 0, verified: 0, rate: null }); // still executing: not settled
    expect(m.no_change).toEqual({ copies: 1, settled: 1, verified: 0, rate: 0 });
    expect(m.unknown).toEqual({ copies: 1, settled: 1, verified: 1, rate: 1 });
    expect(m.maker_failure).toEqual({ copies: 10, settled: 10, verified: 4, rate: 0.4 });
    expect(makerGateMet(m)).toBe(true);
    const below = (verified: number, settled: number): RequeueOutcomes => ({ ...m, maker_failure: { copies: settled, settled, verified, rate: verified / settled } });
    expect(makerGateMet(below(3, 10))).toBe(false); // 30 %
    expect(makerGateMet(below(5, 9))).toBe(false); // 56 % but n < 10
    expect(makerGateMet(null)).toBe(false); // unmeasured = not met
  });

  it('a target is read from grounding.target (else artifactPath) only when it looks like a repo path', () => {
    expect(targetFile(JSON.stringify({ target: 'packages/server/src/services/foo.ts', artifactPath: 'x/y.test.ts' }))).toBe('packages/server/src/services/foo.ts');
    expect(targetFile(JSON.stringify({ target: 'make the loop faster', artifactPath: 'packages/a/b.test.ts' }))).toBe('packages/a/b.test.ts');
    expect(targetFile(JSON.stringify({ target: '../etc/passwd.txt' }))).toBeNull();
    expect(targetFile(null)).toBeNull();
    expect(targetFile('not json')).toBeNull();
  });
});

describe('eligibility', () => {
  it('infra_failed, environment_failure and reviewer_failure originals are requeued exactly once', () => {
    seed('infra', 'infra_failed');
    seed('env', 'regressed'); attribute('env', 'environment_failure');
    seed('rev', 'regressed'); attribute('rev', 'reviewer_failure');
    const r = autoRequeueTick(db, ON, NOW, onMain);
    expect(r.requeued).toHaveLength(3);
    for (const id of ['infra', 'env', 'rev']) {
      const c = copies(id);
      expect(c).toHaveLength(1);
      expect(c[0].approved_by).toBe(AUTO_REQUEUE_ACTOR);
      expect(JSON.parse(c[0].evidence_refs_json)).toContain(`requeue-by:${AUTO_REQUEUE_ACTOR}`);
    }
    // audited through the requeue service's own judgment
    expect(judgments('requeue').map((j) => j.subject_id)).toEqual(['env', 'infra', 'rev']);
    expect(autoRequeueTick(db, ON, NOW, onMain).requeued).toEqual([]);
    for (const id of ['infra', 'env', 'rev']) expect(copies(id)).toHaveLength(1);
  });

  it('maker_failure is not requeued below the measured threshold, and is once the threshold is met', () => {
    seed('mk', 'regressed'); attribute('mk', 'maker_failure');
    makerHistory(3, 10); // 30 %
    expect(autoRequeueTick(db, ON, NOW, { targetOnMain: () => true }).requeued).toEqual([]);
    expect(copies('mk')).toHaveLength(0);
    db.prepare("UPDATE self_improvements SET status = 'verified' WHERE id = 'hc3'").run(); // 4 / 10 = 40 %
    expect(autoRequeueTick(db, ON, NOW, { targetOnMain: () => true }).requeued).toHaveLength(1);
    expect(copies('mk')).toHaveLength(1);
  });

  it('no_change, unknown attribution and a failed requeue copy are never requeued', () => {
    seed('nc', 'no_change');
    seed('unk', 'regressed');
    seed('orig', 'regressed', { age: 20 }); attribute('orig', 'environment_failure');
    seed('copy', 'regressed', { refs: ['requeue-of:orig'] }); attribute('copy', 'environment_failure');
    const r = autoRequeueTick(db, ON, NOW, onMain);
    expect(r.requeued).toEqual([]); // orig already has a copy; the copy itself failed again
    expect(copies('nc')).toHaveLength(0); expect(copies('unk')).toHaveLength(0); expect(copies('copy')).toHaveLength(0);
  });

  it('a human-dismissed row is left alone', () => {
    seed('env', 'regressed', { age: 20 }); attribute('env', 'environment_failure');
    dismissRequeue(db, 'env', 'dennis', 'not worth it');
    autoRequeueTick(db, ON, NOW, onMain);
    expect(copies('env')).toHaveLength(0);
    expect(judgments('requeue_dismiss')).toHaveLength(1);
  });

  it('the lane budget is respected: a test-gap requeue waits while the daily cap is reached', () => {
    seed('tg', 'infra_failed', { refs: ['test-gap:foo'] });
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, evidence_refs_json, created_at, updated_at)
      VALUES ('today', 'test', 't', 'd', 'r', 'gap_analysis', 'proposed', '["test-gap:bar"]', ?, ?)`).run(new Date(NOW).toISOString(), new Date(NOW).toISOString());
    const r = autoRequeueTick(db, { ...ON, TEST_GAP_MAX_PER_DAY: '1' } as NodeJS.ProcessEnv, NOW, onMain);
    expect(r).toMatchObject({ requeued: [], waiting: 1 });
    expect(copies('tg')).toHaveLength(0);
    expect(autoRequeueTick(db, { ...ON, TEST_GAP_MAX_PER_DAY: '2' } as NodeJS.ProcessEnv, NOW, onMain).requeued).toHaveLength(1);
  });

  it('the target file must still be on main: gone = not eligible, unverifiable = held for a human', () => {
    seed('gone', 'infra_failed', { grounding: { target: 'packages/server/src/services/gone.ts' } });
    seed('unsure', 'infra_failed', { grounding: { target: 'packages/server/src/services/unsure.ts' } });
    seed('free', 'infra_failed', { grounding: { target: 'make it faster' } }); // no file target: nothing to check
    const r = autoRequeueTick(db, ON, NOW, { outcomes: null, targetOnMain: (f) => (f.endsWith('gone.ts') ? false : null) });
    expect(r.held).toBe(1);
    expect(copies('gone')).toHaveLength(0); expect(copies('unsure')).toHaveLength(0); expect(copies('free')).toHaveLength(1);
  });

  it('an escalated original is held (it needs explicit human approval), never auto-approved', () => {
    seed('esc', 'infra_failed');
    db.prepare("INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES ('g', 'esc', 't', 'low', 'failed')").run();
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('run', 'g', 'l', 'closed', 'escalated', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(iso(1), iso(1));
    expect(autoRequeueTick(db, ON, NOW, onMain)).toMatchObject({ requeued: [], held: 1, errors: [] });
    expect(decisionsInbox(db, NOW, ON).totals.requeue_open).toBe(1); // the held row is the operator's
  });
});

describe('auto-dismiss', () => {
  it('an ineligible row older than 14 days is dismissed, audited, and nothing is deleted; a younger one waits', () => {
    seed('old', 'regressed', { age: 15 }); attribute('old', 'maker_failure');
    seed('young', 'regressed', { age: 10 }); attribute('young', 'maker_failure');
    seed('oldnc', 'no_change', { age: 20 });
    seed('eligible', 'infra_failed', { age: 20 }); // eligible rows are requeued, never dismissed for their age
    const before = (db.prepare('SELECT COUNT(*) n FROM self_improvements').get() as { n: number }).n;
    const r = autoRequeueTick(db, ON, NOW, onMain);
    expect(r.dismissed.sort()).toEqual(['old', 'oldnc']);
    expect(r.waiting).toBe(1);
    expect(judgments('requeue_dismiss').map((j) => [j.subject_id, j.reason])).toEqual([
      ['old', 'requeue candidate (regressed) dismissed by system:auto-requeue: auto:not_requeue_eligible:maker_failure'],
      ['oldnc', 'requeue candidate (no_change) dismissed by system:auto-requeue: auto:not_requeue_eligible:no_change'],
    ]);
    expect((db.prepare('SELECT COUNT(*) n FROM self_improvements').get() as { n: number }).n).toBe(before + 1); // + the requeue copy, nothing removed
    expect(db.prepare("SELECT status FROM self_improvements WHERE id = 'old'").get()).toEqual({ status: 'regressed' });
    expect(decisionsInbox(db, NOW, ON).requeue.map((x) => x.id)).not.toContain('old');
  });
});

describe('modes', () => {
  const mixed = () => {
    seed('infra', 'infra_failed');
    seed('env', 'regressed'); attribute('env', 'environment_failure');
    seed('mk', 'regressed'); attribute('mk', 'maker_failure');
    seed('oldmk', 'regressed', { age: 16 }); attribute('oldmk', 'maker_failure');
  };

  it('off: the tick touches nothing and the inbox is what it is without the flag', () => {
    mixed();
    const n = rowCount();
    expect(autoRequeueTick(db, {} as NodeJS.ProcessEnv, NOW, onMain)).toMatchObject({ mode: 'off', requeued: [], dismissed: [], shadow_recorded: 0 });
    expect(autoRequeueTick(db, { REQUEUE_AUTO_MODE: 'off' } as NodeJS.ProcessEnv, NOW, onMain).mode).toBe('off');
    expect(rowCount()).toBe(n);
    const off = decisionsInbox(db, NOW, { REQUEUE_AUTO_MODE: 'off' } as NodeJS.ProcessEnv);
    const unset = decisionsInbox(db, NOW, {} as NodeJS.ProcessEnv);
    expect(off.requeue).toEqual(unset.requeue);
    expect(off.requeue.every((r) => r.auto === undefined)).toBe(true);
    expect(off.totals.requeue_open).toBe(3); // the operator class, as before (env + two maker regressions)
    expect(off.totals.requeue_auto).toEqual({ mode: 'off', will_handle: 0, held: 0, by_action: {} });
  });

  it('shadow: one judgment per proposal of what it would do, no copies, no dismisses; bounded per tick', () => {
    mixed();
    const r = autoRequeueTick(db, { ...SHADOW, REQUEUE_AUTO_MAX_PER_TICK: '1' } as NodeJS.ProcessEnv, NOW, onMain);
    expect(r.shadow_recorded).toBe(2); // 1 would-requeue (cap 1) + 1 would-dismiss
    expect(judgments('auto_requeue').map((j) => [j.mode, j.decision])).toEqual(expect.arrayContaining([['shadow', 'would_requeue'], ['shadow', 'would_dismiss']]));
    expect(judgments('auto_requeue').find((j) => j.subject_id === 'oldmk')).toMatchObject({ decision: 'would_dismiss', reason: 'auto:not_requeue_eligible:maker_failure' });
    expect(autoRequeueTick(db, { ...SHADOW, REQUEUE_AUTO_MAX_PER_TICK: '1' } as NodeJS.ProcessEnv, NOW, onMain).shadow_recorded).toBe(1); // the second eligible row
    expect(autoRequeueTick(db, SHADOW, NOW, onMain).shadow_recorded).toBe(0); // each proposal once
    expect(judgments('auto_requeue')).toHaveLength(3);
    expect(judgments('requeue')).toEqual([]); expect(judgments('requeue_dismiss')).toEqual([]);
    expect(copies('infra')).toHaveLength(0); expect(copies('env')).toHaveLength(0);
    // shadow changes nothing that needs you
    expect(decisionsInbox(db, NOW, SHADOW).totals.requeue_open).toBe(3);
  });

  it('on: acts through the requeue service, at most REQUEUE_AUTO_MAX_PER_TICK per tick', () => {
    for (let i = 0; i < 5; i++) seed(`i${i}`, 'infra_failed', { age: 1 + i });
    const env = { ...ON, REQUEUE_AUTO_MAX_PER_TICK: '3' } as NodeJS.ProcessEnv;
    expect(autoRequeueTick(db, env, NOW, onMain).requeued).toHaveLength(3);
    expect(autoRequeueTick(db, env, NOW, onMain).requeued).toHaveLength(2);
    expect(autoRequeueTick(db, env, NOW, onMain).requeued).toHaveLength(0);
    expect(judgments('requeue')).toHaveLength(5);
    expect(autoRequeueTick(db, ON, NOW, onMain).requeued).toHaveLength(0);
  });

  it('on: rows the policy handles show as "system will handle" and leave the needs-you requeue count', () => {
    mixed();
    const inbox = decisionsInbox(db, NOW, ON);
    expect(Object.fromEntries(inbox.requeue.map((r) => [r.id, r.auto?.action]))).toEqual({ infra: 'requeue', env: 'requeue', mk: 'wait', oldmk: 'dismiss' });
    expect(inbox.totals.requeue_auto).toMatchObject({ mode: 'on', will_handle: 4, held: 0 });
    expect(inbox.totals.requeue_open).toBe(0);
    const n = operatorCockpit(db, NOW, ON).needs_you;
    expect(n.requeue).toBe(0);
    expect(n.system.requeue_will_handle).toBe(4);
    // a manual requeue still works next to the policy, and is idempotent with it
    const manual = requeueImprovement(db, 'mk', { actor: 'dennis', reason: 'I know better here' });
    autoRequeueTick(db, ON, NOW, onMain);
    expect(copies('mk').map((c) => c.id)).toEqual([manual.id]);
  });
});
