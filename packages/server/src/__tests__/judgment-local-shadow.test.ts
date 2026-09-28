import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { localShadow, type JudgmentDef } from '../services/judgment-service';

let db: Database.Database;
const def: JudgmentDef = { id: 'discovery_relevance', questions: { actionable: { type: 'noul', instructions: 'q' } },
  decide: (a) => ({ decision: (a.actionable?.noul ?? 0) >= 0.5 ? 'yes' : 'no', reason: `actionable=${a.actionable?.noul}` }) };
const ENV = { TYPESAFE_LOCAL_SHADOW_URL: 'http://ws:8095/', TYPESAFE_LOCAL_SHADOW_TOKEN: 't', TYPESAFE_LOCAL_SHADOW_SAMPLE: '0.2' };
const ok = vi.fn(async () => new Response(JSON.stringify({ model: 'local-qwen36-a3b', answers: { actionable: { type: 'noul', noul: 0.63 } }, usage: { input_tokens: 479 } }), { status: 200 }));
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); ok.mockClear(); });
afterEach(() => db.close());
const rows = () => db.prepare("SELECT judgment, mode, decision, reason, model, input_tokens, error FROM judgments").all();

it('re-asks a sampled judgment locally and records it as <judgment>@local', async () => {
  await localShadow(db, def, { type: 'expert_unit', id: 'u1' }, 'h', { title: 'x', note: 'token=abcdefgh' }, def.questions, undefined, ENV, ok as never, () => 0.1);
  expect(rows()).toEqual([{ judgment: 'discovery_relevance@local', mode: 'shadow', decision: 'yes', reason: 'actionable=0.63', model: 'local-qwen36-a3b', input_tokens: 479, error: null }]);
  const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://ws:8095/v1/systemone');
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  expect(String(init.body)).not.toContain('abcdefgh'); // same secret scrubbing as the jev path
});

it('skips outside the sample and when unconfigured; records upstream errors', async () => {
  await localShadow(db, def, { type: 's', id: '1' }, 'h', {}, def.questions, undefined, ENV, ok as never, () => 0.5);
  await localShadow(db, def, { type: 's', id: '1' }, 'h', {}, def.questions, undefined, {}, ok as never, () => 0);
  expect(ok).not.toHaveBeenCalled();
  await localShadow(db, def, { type: 's', id: '1' }, 'h', {}, def.questions, undefined, ENV, (async () => new Response('', { status: 529 })) as never, () => 0);
  expect(rows()).toEqual([expect.objectContaining({ judgment: 'discovery_relevance@local', decision: 'error', error: 'HTTP 529' })]);
});
