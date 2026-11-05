import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { DataClassification } from '../services/data-classification';
import { dataClassOfSource, egressClassMode, egressEvidence, egressJudgment, makerDiffSource } from '../services/egress-classification';
import { recordModelCall, setLlmLedger } from '../services/model-selector';
import { checkContentSafety, resetContentSafetyPause } from '../services/content-safety';
import { embed } from '../services/proposal-dedupe';
import { TypeSafeClient, resetTypesafeBreaker, resetTypesafeLimiter } from '../services/typesafe-client';
import { runJudgment } from '../services/judgment-service';
import { checkerSecondOpinion } from '../services/judgments/checker-second-opinion';
import { recordWorkerCall } from '../services/model-call-ledger';

// re-20261105 E7 / C4: one egress_class shadow judgment per external model call, on its llm_model_calls row. Never blocks.
let db: Database.Database;
const KEYS = ['EGRESS_CLASS_MODE', 'CONTENT_SAFETY_MODE', 'NVIDIA_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_CHECKER_SECOND_OPINION_MODE', 'SOCIAL_COMPAT_BASE_URL', 'GITHUB_REPOSITORY'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); setLlmLedger(db); resetContentSafetyPause(); resetTypesafeBreaker(); resetTypesafeLimiter();
});
afterEach(() => {
  setLlmLedger(null); db.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const rows = () => db.prepare('SELECT consumer, provider, egress_class FROM llm_model_calls ORDER BY id').all() as Array<{ consumer: string; provider: string | null; egress_class: string | null }>;
const judged = () => rows().map((r) => ({ consumer: r.consumer, ...(r.egress_class ? JSON.parse(r.egress_class) : { none: true }) }));
const json = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const call = (consumer: string, over: Partial<Parameters<typeof recordModelCall>[1]> = {}) =>
  recordModelCall(db, { consumer, model: 'm', ok: true, latencyMs: 1, outChars: 0, shadow: 0, agree: null, ...over });

it('flag: EGRESS_CLASS_MODE off by default (and for any unknown value); only shadow records', () => {
  expect(egressClassMode({})).toBe('off');
  expect(egressClassMode({ EGRESS_CLASS_MODE: 'enforce' })).toBe('off'); // nothing enforces: an unbuilt mode is off, never a block
  expect(egressClassMode({ EGRESS_CLASS_MODE: 'shadow' })).toBe('shadow');
  call('content_safety', { provider: 'nvidia', dataSource: 'kb_page' });
  expect(rows()[0].egress_class).toBeNull();
});

it('data class of the payload source: a KB page is private, a djimitflo maker diff is public, an unknown repo is confidential', () => {
  expect(dataClassOfSource('content_safety', 'kb_page')).toBe(DataClassification.CONFIDENTIAL);
  expect(dataClassOfSource('jev', 'maker_diff:djimit/djimitflo')).toBe(DataClassification.PUBLIC);
  expect(dataClassOfSource('jev', 'maker_diff:DJIMIT/DjimitFlo')).toBe(DataClassification.PUBLIC);
  expect(dataClassOfSource('jev', 'maker_diff:djimit/private-thing')).toBe(DataClassification.CONFIDENTIAL);
  expect(dataClassOfSource('panel_review', null)).toBe(DataClassification.INTERNAL); // no source: the consumer's documented assumption
  expect(dataClassOfSource('jev', undefined)).toBe(DataClassification.CONFIDENTIAL);
});

it('rule: confidential/restricted → any non-local destination would be denied; local never; public/internal never', () => {
  const j = (consumer: string, provider: string | null, model: string, source?: string) => egressJudgment({ consumer, provider, model, dataSource: source }, {});
  expect(j('content_safety', 'nvidia', 'x', 'kb_page')).toEqual({ host: 'integrate.api.nvidia.com', dest: 'us_cloud', data: 'confidential', source: 'kb_page', would_deny: true });
  expect(j('jev', 'typesafe', 'jev', 'maker_diff:djimit/djimitflo')).toMatchObject({ host: 'api.typesafe.ai', dest: 'unknown', data: 'public', would_deny: false });
  expect(j('jev', 'typesafe', 'jev')).toMatchObject({ dest: 'unknown', data: 'confidential', source: null, would_deny: true });
  expect(j('fallback', 'ollama:http://localhost:11434', 'gemma', 'kb_page')).toMatchObject({ host: 'localhost', dest: 'local', data: 'confidential', would_deny: false });
  expect(j('panel_review', null, 'kimi-k3:cloud')).toMatchObject({ host: 'ollama.com', dest: 'us_cloud', data: 'internal', would_deny: false });
});

it('shadow: content safety and the embedding of a KB page record would_deny on NVIDIA; the calls themselves are unchanged', async () => {
  process.env.EGRESS_CLASS_MODE = 'shadow'; process.env.CONTENT_SAFETY_MODE = 'shadow'; process.env.NVIDIA_API_KEY = 'k';
  const verdict = await checkContentSafety(db, { type: 'kb_page', id: 'wiki/a.md' }, 'private notes', json({ choices: [{ message: { content: 'User Safety: safe' } }] }), true, true);
  expect(verdict).toBe('safe'); // never blocks
  const v = await embed('private notes', json({ data: [{ embedding: [0.1, 0.2] }] }), 'passage', 'kb_page');
  expect(v && Array.from(v).length).toBe(2);
  expect(judged()).toEqual([
    { consumer: 'content_safety', host: 'integrate.api.nvidia.com', dest: 'us_cloud', data: 'confidential', source: 'kb_page', would_deny: true },
    { consumer: 'embeddings', host: 'integrate.api.nvidia.com', dest: 'us_cloud', data: 'confidential', source: 'kb_page', would_deny: true },
  ]);
});

it('shadow: a social reply checked by content safety keeps the consumer assumption (internal, not denied)', async () => {
  process.env.EGRESS_CLASS_MODE = 'shadow'; process.env.CONTENT_SAFETY_MODE = 'shadow'; process.env.NVIDIA_API_KEY = 'k';
  await checkContentSafety(db, { type: 'social_reply', id: 'm1' }, 'hello', json({ choices: [{ message: { content: 'User Safety: safe' } }] }));
  expect(judged()).toEqual([{ consumer: 'content_safety', host: 'integrate.api.nvidia.com', dest: 'us_cloud', data: 'internal', source: 'social_reply', would_deny: false }]);
});

it('shadow: jev second opinion on a djimitflo maker diff is public (TypeSafe not denied); the source reaches the ledger through runJudgment', async () => {
  process.env.EGRESS_CLASS_MODE = 'shadow'; process.env.TYPESAFE_API_KEY = 'k'; process.env.TYPESAFE_CHECKER_SECOND_OPINION_MODE = 'shadow';
  const client = new TypeSafeClient(json({ model: 'jev-1.13.0', answers: { verdict: { choice: 'accepted', confidence: 0.9 } } }));
  const rec = await runJudgment(db, checkerSecondOpinion, { type: 'worker_lease', id: 'l1' }, { task: 't', diff: 'd', checks: [] }, client,
    { checkerVerdict: 'accepted', dataSource: makerDiffSource(db, null) });
  expect(rec).not.toBeNull(); // the judgment itself is recorded as before
  expect(judged()).toEqual([{ consumer: 'jev', host: 'api.typesafe.ai', dest: 'unknown', data: 'public', source: 'maker_diff:djimit/djimitflo', would_deny: false }]);
});

it('shadow: maker/checker ledger rows carry the maker diff source of their goal repo; panel and residents keep their consumer class', () => {
  process.env.EGRESS_CLASS_MODE = 'shadow'; process.env.SOCIAL_COMPAT_BASE_URL = 'http://100.70.1.1:4000/v1';
  expect(makerDiffSource(db, null)).toBe('maker_diff:djimit/djimitflo');
  process.env.GITHUB_REPOSITORY = 'djimit/other';
  expect(makerDiffSource(db, null)).toBe('maker_diff:djimit/other');
  recordWorkerCall(db, { consumer: 'maker', runId: 'r1', goalId: null, loopName: 'l', runtime: 'opencode', provider: 'ollama:https://ollama.com', meta: { model: 'glm-5:cloud' }, durationMs: 1, ok: true });
  delete process.env.GITHUB_REPOSITORY;
  recordWorkerCall(db, { consumer: 'checker', runId: 'r1', goalId: null, loopName: 'l', runtime: 'opencode', provider: 'ollama:https://ollama.com', meta: { model: 'glm-5:cloud' }, durationMs: 1, ok: true });
  call('panel_review', { model: 'kimi-k3:cloud' });
  call('resident:ada', { provider: 'openai-compatible' });
  expect(judged()).toEqual([
    { consumer: 'maker', host: 'ollama.com', dest: 'us_cloud', data: 'confidential', source: 'maker_diff:djimit/other', would_deny: true },
    { consumer: 'checker', host: 'ollama.com', dest: 'us_cloud', data: 'public', source: 'maker_diff:djimit/djimitflo', would_deny: false },
    { consumer: 'panel_review', host: 'ollama.com', dest: 'us_cloud', data: 'internal', source: null, would_deny: false },
    { consumer: 'resident:ada', host: '100.70.1.1', dest: 'local', data: 'internal', source: null, would_deny: false },
  ]);
});

it('readout: evolution evidence egress.shadow counts judged rows, would_deny per consumer × destination × data class, and the unjudged rest', () => {
  call('jev', { provider: 'typesafe' }); // before the flag: no judgment
  process.env.EGRESS_CLASS_MODE = 'shadow';
  call('content_safety', { provider: 'nvidia', dataSource: 'kb_page' });
  call('content_safety', { provider: 'nvidia', dataSource: 'kb_page' });
  call('jev', { provider: 'typesafe', dataSource: 'maker_diff:djimit/djimitflo' });
  call('fallback', { provider: 'ollama:http://localhost:11434', dataSource: 'kb_page' });
  const s = egressEvidence(db, process.env, Date.now()).shadow;
  expect(s).toMatchObject({ mode: 'shadow', calls: 5, judged: 4, unjudged: 1, would_deny: 2 });
  expect(s.by).toEqual(expect.arrayContaining([
    { consumer: 'content_safety', dest: 'us_cloud', data: 'confidential', calls: 2, would_deny: 2 },
    { consumer: 'jev', dest: 'unknown', data: 'public', calls: 1, would_deny: 0 },
    { consumer: 'fallback', dest: 'local', data: 'confidential', calls: 1, would_deny: 0 },
  ]));
  expect(egressEvidence(new Database(':memory:'), {}, Date.now()).shadow).toMatchObject({ mode: 'off', calls: 0, judged: 0 }); // no table: never throws
});
