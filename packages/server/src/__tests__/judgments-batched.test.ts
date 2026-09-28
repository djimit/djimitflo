import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { runJudgments, type JudgmentDef } from '../services/judgment-service';
import type { TypeSafeClient, TsQuestion } from '../services/typesafe-client';

let db: Database.Database; const env = { ...process.env };
const def = (id: string, key: string): JudgmentDef => ({
  id, questions: { [key]: { type: 'noul', instructions: `q ${id}` } },
  decide: (a) => ({ decision: (a[key]?.noul ?? 0) > 0.5 ? 'yes' : 'no', reason: `${key}=${a[key]?.noul}` }),
});
const A = def('judge_a', 'x'); const B = def('judge_b', 'x'); // same inner key: namespacing must keep them apart
const fake = (calls: Array<Record<string, TsQuestion>>) => ({
  systemOne: async (_state: unknown, questions: Record<string, TsQuestion>) => {
    calls.push(questions);
    return { model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: k.startsWith('judge_b') ? 0.1 : 0.9 }])), usage: { input_tokens: 100, output_tokens: 10 } };
  },
}) as unknown as TypeSafeClient;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  Object.assign(process.env, { TYPESAFE_API_KEY: 'test', TYPESAFE_JUDGE_A_MODE: 'shadow', TYPESAFE_JUDGE_B_MODE: 'shadow' });
});
afterEach(() => { db.close(); process.env = { ...env }; });

it('asks several judgments in one request and records each on its own row', async () => {
  const calls: Array<Record<string, TsQuestion>> = [];
  const [a, b] = await runJudgments(db, [A, B], { type: 's', id: '1' }, { text: 't' }, fake(calls));
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0]).sort()).toEqual(['judge_a__x', 'judge_b__x']);
  expect([a?.decision, b?.decision]).toEqual(['yes', 'no']);
  expect(db.prepare('SELECT judgment, decision, input_tokens FROM judgments ORDER BY judgment').all()).toEqual([
    { judgment: 'judge_a', decision: 'yes', input_tokens: 50 }, { judgment: 'judge_b', decision: 'no', input_tokens: 50 },
  ]);
});

it('falls back to a single judgment call when only one is on', async () => {
  delete process.env.TYPESAFE_JUDGE_B_MODE;
  const calls: Array<Record<string, TsQuestion>> = [];
  const [a, b] = await runJudgments(db, [A, B], { type: 's', id: '1' }, {}, fake(calls));
  expect(calls).toHaveLength(1); expect(Object.keys(calls[0])).toEqual(['x']);
  expect(a?.decision).toBe('yes'); expect(b).toBeNull();
});
