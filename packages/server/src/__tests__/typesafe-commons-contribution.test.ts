import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TypeSafeClient, resetTypesafeBreaker } from '../services/typesafe-client';
import { runJudgment } from '../services/judgment-service';
import { commonsContribution } from '../services/judgments/commons-contribution';

let db: Database.Database;
const answers = (choice: string, confidence: number, novel: number) => ({ contribution: { type: 'choice', choice, confidence, probabilities: {} }, novel: { type: 'noul', noul: novel } });
const client = (a: unknown) => new TypeSafeClient(vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: a }) }) as unknown as typeof fetch);
const run = (a: unknown, id: string) => runJudgment(db, commonsContribution, { type: 'agent_message', id }, { topic: 't', earlier: [], message: 'm' }, client(a));

beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); process.env.TYPESAFE_API_KEY = 'k'; process.env.TYPESAFE_COMMONS_CONTRIBUTION_MODE = 'shadow'; resetTypesafeBreaker(); });
afterEach(() => { delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_COMMONS_CONTRIBUTION_MODE; db.close(); });

it('novel evidence, next steps and counterarguments are useful; restatements and off-topic are not', async () => {
  expect((await run(answers('evidence', 0.9, 0.8), 'a'))?.decision).toBe('yes');
  expect((await run(answers('falsifiable_next_step', 0.8, 0.7), 'b'))?.decision).toBe('yes');
  expect((await run(answers('evidence', 0.9, 0.2), 'c'))?.decision).toBe('no'); // evidence already stated earlier
  expect((await run(answers('restatement', 0.9, 0.1), 'd'))?.reason).toBe('jev=restatement conf=0.90 novel=0.10');
  expect((await run(answers('off_topic', 0.4, 0.9), 'e'))?.decision).toBe('uncertain');
});
