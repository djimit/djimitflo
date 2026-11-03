import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TypeSafeClient, resetTypesafeBreaker } from '../services/typesafe-client';
import { runJudgment } from '../services/judgment-service';
import { reflectionTriage } from '../services/judgments/reflection-triage';
import { SelfImprovementService } from '../services/self-improvement-service';

let db: Database.Database;
const answer = (choice: string, confidence: number) => ({ kind: { type: 'choice', choice, confidence, probabilities: {} } });
const client = (a: unknown) => new TypeSafeClient(vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: a }) }) as unknown as typeof fetch);

beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); process.env.TYPESAFE_API_KEY = 'k'; process.env.TYPESAFE_REFLECTION_TRIAGE_MODE = 'shadow'; resetTypesafeBreaker(); });
afterEach(() => { delete process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_REFLECTION_TRIAGE_MODE; delete process.env.PROPOSAL_GROUNDING_REQUIRED; vi.unstubAllGlobals(); db.close(); });

it('djimitflo change -> yes, other system / aspiration -> no, low confidence -> uncertain', async () => {
  const run = (a: unknown, id: string) => runJudgment(db, reflectionTriage, { type: 'self_improvement', id }, { proposal: { title: 't' } }, client(a));
  expect((await run(answer('djimitflo_change', 0.9), 'a'))?.decision).toBe('yes');
  expect((await run(answer('other_system', 0.8), 'b'))?.decision).toBe('no');
  expect((await run(answer('aspiration', 0.7), 'c'))?.reason).toBe('jev=aspiration conf=0.70');
  expect((await run(answer('djimitflo_change', 0.3), 'd'))?.decision).toBe('uncertain');
});

it('an ungrounded reflection proposal is parked and triaged in shadow; a grounded one is not', async () => {
  process.env.PROPOSAL_GROUNDING_REQUIRED = 'true';
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: answer('aspiration', 0.9) }) });
  vi.stubGlobal('fetch', fetchMock);
  const svc = new SelfImprovementService(db);
  const parked = svc.createProposal({ type: 'feature', title: 'Explore persuasion research', description: 'a broad idea', rationale: 'why', source: 'reflection', priority: 0.5, evidenceRefs: ['reflection:1'] });
  expect(parked?.status).toBe('needs_grounding');
  await vi.waitFor(() => expect(db.prepare("SELECT decision FROM judgments WHERE judgment = 'reflection_triage'").get()).toEqual({ decision: 'no' }));
  svc.createProposal({ type: 'feature', title: 'Fix x', description: 'edit packages/server/src/index.ts', rationale: 'why', source: 'reflection', priority: 0.5, evidenceRefs: ['reflection:2'] });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
