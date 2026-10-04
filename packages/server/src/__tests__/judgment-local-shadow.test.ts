import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { localShadow } from '../services/judgment-service';
import { LocalShadowQueue } from '../services/local-shadow-queue';
import { discoveryRelevance } from '../services/judgments/discovery-relevance';

let db: Database.Database; let q: LocalShadowQueue;
const ON = { TYPESAFE_LOCAL_SHADOW_ENABLED: 'true', TYPESAFE_LOCAL_SHADOW_SAMPLE: '0.2' };
const enqueue = (id = 'u1', random = 0.1, env: NodeJS.ProcessEnv = ON) =>
  localShadow(db, discoveryRelevance, { type: 'expert_unit', id }, 'h', { title: 'x', note: 'token=abcdefghij' }, discoveryRelevance.questions, undefined, env, () => random);
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); q = new LocalShadowQueue(db); });
afterEach(() => { db.close(); vi.useRealTimers(); });
const judged = () => db.prepare("SELECT judgment, mode, decision, reason, model, error FROM judgments").all();

it('queues a sampled judgment (scrubbed) instead of calling anything; off without the flag or outside the sample', () => {
  enqueue('u1', 0.5); enqueue('u2', 0.1, {}); expect(q.claim('workstation')).toEqual([]);
  enqueue('u3');
  const [job] = q.claim('workstation');
  expect(JSON.stringify(job.state)).not.toContain('abcdefghij');
  expect(Object.keys(job.questions as object)).toEqual(['relevance', 'actionable']);
  expect(q.claim('workstation')).toEqual([]); // claimed once
});

it('decides the local answers with the judgment\'s own rule and records <judgment>@local, only for the claiming host', () => {
  enqueue();
  const [job] = q.claim('workstation');
  expect(() => q.record(job.id, 'macmini', {})).toThrow('SHADOW_JOB_NOT_FOUND');
  q.record(job.id, 'workstation', { model: 'local-qwen36-a3b', input_tokens: 479, latency_ms: 9000, answers: {
    relevance: { type: 'choice', choice: 'lane_technique', confidence: 0.68, probabilities: {} }, actionable: { type: 'noul', noul: 0.63 } } });
  expect(judged()).toEqual([{ judgment: 'discovery_relevance@local', mode: 'shadow', decision: 'yes', reason: 'relevance=lane_technique conf=0.68 actionable=0.63', model: 'local-qwen36-a3b', error: null }]);
  expect(() => q.record(job.id, 'workstation', {})).toThrow('SHADOW_JOB_NOT_CLAIMED');
});

it('records local errors, re-offers claims older than 30 minutes and caps the queue at 500', () => {
  vi.useFakeTimers({ now: Date.parse('2026-09-29T00:00:00Z') });
  enqueue(); const [a] = q.claim('workstation');
  q.record(a.id, 'workstation', { error: 'upstream 529' });
  expect(judged()).toEqual([expect.objectContaining({ judgment: 'discovery_relevance@local', decision: 'error', error: 'upstream 529' })]);
  enqueue('u2'); q.claim('workstation');
  vi.setSystemTime(Date.parse('2026-09-29T00:31:00Z'));
  expect(q.claim('workstation')).toHaveLength(1);
  const ins = db.prepare("INSERT INTO local_shadow_jobs (id, judgment, subject_type, subject_id, state_hash, state_json, questions_json, created_at) VALUES (?, 'x', 's', 's', 'h', '{}', '{}', '')");
  for (let i = 0; i < 500; i++) ins.run(`f${i}`);
  enqueue('u9');
  expect((db.prepare("SELECT COUNT(*) n FROM local_shadow_jobs WHERE subject_id = 'u9'").get() as { n: number }).n).toBe(0);
});

it('does not queue judgments the local shadow cannot decide (prod 29-09: kb_passage_relevance → unknown judgment)', () => {
  const dynamic = { id: 'kb_passage_relevance', questions: { p0: { type: 'noul' as const, instructions: 'x' } }, decide: () => ({ decision: 'yes' as const, reason: '' }) };
  localShadow(db, dynamic, { type: 'specialist_panel', id: 'p' }, 'h', {}, dynamic.questions, undefined, ON, () => 0);
  expect(q.claim('workstation')).toEqual([]);
});
