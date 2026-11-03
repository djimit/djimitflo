import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

const step = (total: number, input: number, output: number) => JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { total, input, output, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0 } });

it('sums opencode step_finish tokens (prod 2026-09-25: tokens_used was always 0)', () => {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const svc = new LoopService(db);
  const stdout = [JSON.stringify({ type: 'step_start' }), step(13561, 11100, 285), JSON.stringify({ type: 'text', part: { text: 'hi' } }), step(19890, 5048, 1594)].join('\n');
  expect(svc.extractRuntimeUsage(stdout)).toEqual({ prompt_tokens: 16148, completion_tokens: 1879, total_tokens: 33451, usage_source: 'runtime_stdout' });
  expect(svc.extractRuntimeUsage(JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 4 } }))?.total_tokens).toBe(7); // other runtimes unchanged
  db.close();
});
