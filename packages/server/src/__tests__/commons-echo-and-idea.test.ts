import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TypeSafeClient, resetTypesafeBreaker } from '../services/typesafe-client';
import { runJudgment } from '../services/judgment-service';
import { commonsIdea } from '../services/judgments/commons-idea';
import { isEcho } from '../services/agent-social-autopilot-service';

let db: Database.Database;
const ans = (kind: string, conf: number, grounded: number) => ({ kind: { type: 'choice', choice: kind, confidence: conf, probabilities: {} }, grounded: { type: 'noul', noul: grounded } });
const client = (a: unknown) => new TypeSafeClient(vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: a }) }) as unknown as typeof fetch);
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); process.env.TYPESAFE_API_KEY = 'k'; process.env.TYPESAFE_COMMONS_IDEA_MODE = 'shadow'; resetTypesafeBreaker(); });
afterEach(() => { delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_COMMONS_IDEA_MODE; db.close(); });

it('an echo is the peer answer again, ignoring case and whitespace; an own evaluation is not', () => {
  expect(isEcho('Run a  control.\n', 'run a control.')).toBe(true);
  expect(isEcho('The peer skipped the control; run it first.', 'Run a control.')).toBe(false);
  expect(isEcho('', '')).toBe(false);
});

it('commons_idea: only concrete Djimitflo changes grounded in an observed problem are harvest candidates', async () => {
  const run = (a: unknown, id: string) => runJudgment(db, commonsIdea, { type: 'agent_message', id }, { idea: 'x' }, client(a));
  expect((await run(ans('concrete_djimitflo_change', 0.9, 0.8), 'a'))?.decision).toBe('yes');
  expect((await run(ans('concrete_djimitflo_change', 0.9, 0.2), 'b'))?.decision).toBe('no'); // a general topic, not an observed problem
  expect((await run(ans('vague_djimitflo_change', 0.9, 0.9), 'c'))?.reason).toBe('kind=vague_djimitflo_change conf=0.90 grounded=0.90');
  expect((await run(ans('other_system', 0.4, 0.9), 'd'))?.decision).toBe('uncertain');
  expect((await run(ans('other_system', 0.9, 0.9), 'e'))?.decision).toBe('no'); // e.g. a DjimitKBWiki schema change
});
