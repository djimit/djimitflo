import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TypeSafeClient, resetTypesafeBreaker } from '../services/typesafe-client';
import { runJudgment } from '../services/judgment-service';
import { checkerSecondOpinion, checkerSecondOpinionState } from '../services/judgments/checker-second-opinion';
import { shouldRecordSecondOpinion } from '../services/loop-worker-executor-service';

let db: Database.Database;
const choice = (c: string, confidence: number) => ({ verdict: { type: 'choice', choice: c, confidence, probabilities: {} } });
const client = (answers: unknown, sent: unknown[] = []) => new TypeSafeClient(vi.fn().mockImplementation(async (_u, init) => {
  sent.push(JSON.parse(String(init.body)));
  return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers }) };
}) as unknown as typeof fetch);

beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); process.env.TYPESAFE_API_KEY = 'k'; process.env.TYPESAFE_CHECKER_SECOND_OPINION_MODE = 'shadow'; resetTypesafeBreaker(); });
afterEach(() => { delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_CHECKER_SECOND_OPINION_MODE; db.close(); });

it('records agreement with the real checker, gated on confidence', async () => {
  const s = checkerSecondOpinionState('add a test', 'diff --git a/x b/x', []);
  const agree = await runJudgment(db, checkerSecondOpinion, { type: 'worker_lease', id: 'l1' }, s, client(choice('accepted', 0.9)), { checkerVerdict: 'accepted' });
  expect(agree).toMatchObject({ decision: 'yes', reason: 'jev=accepted conf=0.90 checker=accepted agree' });
  const disagree = await runJudgment(db, checkerSecondOpinion, { type: 'worker_lease', id: 'l2' }, s, client(choice('rejected', 0.8)), { checkerVerdict: 'accepted' });
  expect(disagree?.decision).toBe('no'); expect(disagree?.reason).toContain('disagree');
  const unsure = await runJudgment(db, checkerSecondOpinion, { type: 'worker_lease', id: 'l3' }, s, client(choice('accepted', 0.4)), { checkerVerdict: 'accepted' });
  expect(unsure?.decision).toBe('uncertain');
  expect(db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'checker_second_opinion'").get()).toEqual({ n: 3 });
});

it('S2: atomic questions ride in the same request; a confident accept that weakens assertions or adds trivial tests is a no', async () => {
  const s = checkerSecondOpinionState('add a test for parseSafety', 'diff --git a/x.test.ts b/x.test.ts', []);
  const sent: any[] = [];
  const answers = (weakens: number, trivial: number, named: number) => ({ ...choice('accepted', 0.9),
    tests_named_behaviour: { type: 'noul', noul: named }, weakens_assertions: { type: 'noul', noul: weakens }, trivial_tests: { type: 'noul', noul: trivial } });
  const good = await runJudgment(db, checkerSecondOpinion, { type: 'worker_lease', id: 'a1' }, s, client(answers(0.05, 0.1, 0.9), sent), { checkerVerdict: 'accepted' });
  expect(good).toMatchObject({ decision: 'yes', reason: 'jev=accepted conf=0.90 checker=accepted agree | tests_named_behaviour=0.90 weakens_assertions=0.05 trivial_tests=0.10' });
  expect(Object.keys(sent[0].questions).sort()).toEqual(['tests_named_behaviour', 'trivial_tests', 'verdict', 'weakens_assertions']);
  for (const [w, t, n] of [[0.9, 0.1, 0.9], [0.1, 0.8, 0.9], [0.1, 0.1, 0.2]]) {
    const r = await runJudgment(db, checkerSecondOpinion, { type: 'worker_lease', id: `b${w}${t}${n}` }, s, client(answers(w, t, n)), { checkerVerdict: 'accepted' });
    expect(r).toMatchObject({ decision: 'no', reason: expect.stringContaining('atomic veto') });
  }
});

it('runs once per maker: for the checker, never again for the security checker, never on mock or when off', () => {
  expect(shouldRecordSecondOpinion('opencode', 'checker', 'shadow')).toBe(true);
  expect(shouldRecordSecondOpinion('opencode', 'security_checker', 'shadow')).toBe(false);
  expect(shouldRecordSecondOpinion('mock', 'checker', 'shadow')).toBe(false);
  expect(shouldRecordSecondOpinion('opencode', 'checker', 'off')).toBe(false);
});

it('sends only task, capped diff and checks — never the checker notes', async () => {
  const sent: any[] = [];
  await runJudgment(db, checkerSecondOpinion, { type: 'worker_lease', id: 'l4' }, checkerSecondOpinionState('t', 'x'.repeat(50_000), []), client(choice('accepted', 0.9), sent), { checkerVerdict: 'accepted' });
  expect(Object.keys(sent[0].state).sort()).toEqual(['checks', 'diff', 'task']);
  expect(sent[0].state.diff.length).toBe(24_000);
  expect(sent[0].questions.verdict.type).toBe('choice');
  expect(checkerSecondOpinionState('t', '', []).diff).toBe('(empty diff)');
});
