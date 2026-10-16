import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TypeSafeClient, resetTypesafeBreaker, resetTypesafeLimiter } from '../services/typesafe-client';
import { setLlmLedger } from '../services/model-selector';
import { challengerSampled, runJudgment, runJudgments, settleChallengers } from '../services/judgment-service';
import { proposalPrescreen } from '../services/judgments/proposal-prescreen';
import { commonsContribution } from '../services/judgments/commons-contribution';
import { commonsIdea } from '../services/judgments/commons-idea';
import { challengerRate, jevChallengerEvidence } from '../services/jev-challenger';
import { D5NO_CUTOFF, d5NoEvidence } from '../services/d5-no';
import { forecastScores } from '../services/forecast-scoring';
import { ImprovementFunnelService } from '../services/improvement-funnel-service';
import { detectStalls } from '../services/stall-watch';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';

const noul = (p: number) => ({ type: 'noul', noul: p });
const YES = { names_file: noul(0.95), verifiable: noul(0.9), concrete: noul(0.9), sensitive: noul(0.05) };
const NO = { names_file: noul(0.1), verifiable: noul(0.9), concrete: noul(0.9), sensitive: noul(0.05) };
let db: Database.Database;

/** Answers per requested model; records each request body. */
function fakeFetch(byModel: Record<string, Record<string, unknown> | 'error'>) {
  const bodies: Array<{ model: string; state: unknown; questions: unknown }> = [];
  const f = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { model: string; state: unknown; questions: unknown };
    bodies.push(body);
    const answers = byModel[body.model];
    if (answers === 'error' || !answers) return { ok: false, status: 422, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ model: body.model, answers, usage: { input_tokens: 100, output_tokens: 10 } }) };
  });
  return { client: new TypeSafeClient(f as unknown as typeof fetch), bodies, f };
}

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); setLlmLedger(db);
  vi.stubEnv('TYPESAFE_API_KEY', 'k'); vi.stubEnv('TYPESAFE_PROPOSAL_PRESCREEN_MODE', 'shadow'); vi.stubEnv('TYPESAFE_MODEL', '');
  resetTypesafeBreaker(); resetTypesafeLimiter();
});
afterEach(() => { vi.unstubAllEnvs(); setLlmLedger(null); resetTypesafeLimiter(); db.close(); });

const subject = { type: 'self_improvement', id: 'p1' };
const state = { proposal: { title: 't', description: 'touch packages/server/src/a.ts' } };

it('off (JEV_CHALLENGER_MODEL unset): one call, no challenger row', async () => {
  const { client, f } = fakeFetch({ 'jev-1.13.0': YES, 'jev-1.14.0': NO });
  expect((await runJudgment(db, proposalPrescreen, subject, state, client))?.decision).toBe('yes');
  await settleChallengers();
  expect(f).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT COUNT(*) n FROM judgments WHERE instr(judgment, '@') > 0").get()).toEqual({ n: 0 });
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'JEV_CHALLENGER_MODEL', acting: false });
});

it('on + sampled: two calls with the identical request, primary decision unchanged, challenger stored as <judgment>@<model>', async () => {
  vi.stubEnv('JEV_CHALLENGER_MODEL', 'jev-1.14.0'); vi.stubEnv('JEV_CHALLENGER_SAMPLE', '1');
  const { client, bodies } = fakeFetch({ 'jev-1.13.0': YES, 'jev-1.14.0': NO });
  const primary = await runJudgment(db, proposalPrescreen, subject, state, client, { pathExists: true });
  expect(primary?.decision).toBe('yes'); // the challenger said no; the caller still gets the primary's decision
  await settleChallengers();
  expect(bodies.map((b) => b.model)).toEqual(['jev-1.13.0', 'jev-1.14.0']);
  expect(bodies[1].state).toEqual(bodies[0].state); expect(bodies[1].questions).toEqual(bodies[0].questions);
  const rows = db.prepare('SELECT judgment, mode, decision, subject_type, subject_id, state_hash, model FROM judgments ORDER BY rowid').all() as Array<Record<string, string>>;
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ judgment: 'proposal_prescreen@jev-1.14.0', mode: 'shadow', decision: 'no', subject_type: 'self_improvement', subject_id: 'p1', model: 'jev-1.14.0' });
  expect(rows[1].state_hash).toBe(rows[0].state_hash);
  expect(rows[0]).toMatchObject({ judgment: 'proposal_prescreen', decision: 'yes' });
  expect(db.prepare("SELECT model, purpose FROM llm_model_calls WHERE consumer = 'jev' ORDER BY id").all())
    .toEqual([{ model: 'jev-1.13.0', purpose: 'jev:systemone' }, { model: 'jev-1.14.0', purpose: 'jev:challenger' }]);
});

it('runJudgments: the combined request is replayed once and split into one challenger row per judgment', async () => {
  vi.stubEnv('JEV_CHALLENGER_MODEL', 'jev-1.14.0'); vi.stubEnv('JEV_CHALLENGER_SAMPLE', '1');
  vi.stubEnv('TYPESAFE_COMMONS_CONTRIBUTION_MODE', 'shadow'); vi.stubEnv('TYPESAFE_COMMONS_IDEA_MODE', 'shadow');
  const { client, bodies } = fakeFetch({ 'jev-1.13.0': {}, 'jev-1.14.0': {} });
  await runJudgments(db, [commonsContribution, commonsIdea], { type: 'agent_message', id: 'm1' }, { text: 'x' }, client);
  await settleChallengers();
  expect(bodies).toHaveLength(2); expect(bodies[1].questions).toEqual(bodies[0].questions);
  expect((db.prepare("SELECT judgment FROM judgments WHERE instr(judgment, '@') > 0 ORDER BY judgment").all() as Array<{ judgment: string }>).map((r) => r.judgment))
    .toEqual(['commons_contribution@jev-1.14.0', 'commons_idea@jev-1.14.0']);
});

it('unsampled: one call; the sample is deterministic in (judgment, state_hash)', async () => {
  vi.stubEnv('JEV_CHALLENGER_MODEL', 'jev-1.14.0'); vi.stubEnv('JEV_CHALLENGER_SAMPLE', '0');
  const { client, f } = fakeFetch({ 'jev-1.13.0': YES, 'jev-1.14.0': NO });
  await runJudgment(db, proposalPrescreen, subject, state, client); await settleChallengers();
  expect(f).toHaveBeenCalledTimes(1);
  const hashes = Array.from({ length: 400 }, (_, i) => `h${i}`);
  const picked = hashes.filter((h) => challengerSampled('proposal_prescreen', h, 0.2));
  expect(hashes.filter((h) => challengerSampled('proposal_prescreen', h, 0.2))).toEqual(picked); // reruns pick the same subjects
  expect(picked.length).toBeGreaterThan(40); expect(picked.length).toBeLessThan(120);
});

it('a challenger error never reaches the caller and never opens the primary breaker', async () => {
  vi.stubEnv('JEV_CHALLENGER_MODEL', 'jev-1.14.0'); vi.stubEnv('JEV_CHALLENGER_SAMPLE', '1');
  const { client, f } = fakeFetch({ 'jev-1.13.0': YES, 'jev-1.14.0': 'error' });
  for (let i = 0; i < 4; i += 1) {
    expect((await runJudgment(db, proposalPrescreen, { type: 'self_improvement', id: `p${i}` }, { i }, client))?.decision).toBe('yes');
    await settleChallengers();
  }
  expect(f).toHaveBeenCalledTimes(8); // 3 challenger failures did not open the breaker for the primary
  expect(db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'proposal_prescreen@jev-1.14.0' AND decision = 'error'").get()).toEqual({ n: 4 });
});

it('busy limiter: a challenger call is dropped (dropped_busy), never queued', async () => {
  vi.stubEnv('TYPESAFE_MAX_CONCURRENCY', '1');
  let release: () => void = () => undefined;
  const f = vi.fn(() => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: {} }) }); }));
  const c = new TypeSafeClient(f as unknown as typeof fetch);
  const first = c.systemOne({}, {}, { retries: 0 });
  await new Promise((r) => setTimeout(r, 0));
  await expect(c.systemOne({}, {}, { retries: 0, model: 'jev-1.14.0', purpose: 'jev:challenger', noWait: true })).rejects.toThrow('TYPESAFE_DROPPED_BUSY');
  release(); await first;
  expect(f).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT status FROM llm_model_calls WHERE model = 'jev-1.14.0'").all()).toEqual([{ status: 'dropped_busy' }]);
});

const insert = (judgment: string, sid: string, decision: string, at: string, answers: unknown = {}, mode = 'shadow', hash = `h-${sid}`) =>
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, ?, 'self_improvement', ?, ?, ?, ?, 'r', ?, ?)`).run(randomUUID(), judgment, sid, hash, mode, decision, JSON.stringify(answers), at);
const proposal = (id: string, status: string, at: string, description: string) =>
  db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at)
    VALUES (?, 'feature', 't', ?, 'r', 'reflection', ?, 0.5, '[]', ?, ?)`).run(id, description, status, at, at);

it('agreement + ground truth: Wilson CI at n ≥ 20, insufficient (null, never 0) below', () => {
  expect(challengerRate(0, 5)).toEqual({ k: 0, n: 5, rate: null, ci_low: null, ci_high: null, status: 'insufficient' });
  const at = new Date(Date.parse(D5NO_CUTOFF) + 3_600_000).toISOString();
  for (let i = 0; i < 25; i += 1) {
    proposal(`s${i}`, 'rejected', at, i % 2 ? 'change packages/server/src/x.ts' : 'improve things');
    const pa = { names_file: noul(i % 2 ? 0.9 : 0.1) };
    insert('proposal_prescreen', `s${i}`, 'no', at, pa);
    insert('proposal_prescreen@jev-1.14.0', `s${i}`, i < 20 ? 'no' : 'yes', at, { names_file: noul(i < 5 ? 0.9 : i % 2 ? 0.9 : 0.1) });
    if (i < 3) db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
      VALUES (?, 'operator_label', 'self_improvement', ?, 'proposal_prescreen', 'enforce', 'yes', 'ok', ?)`).run(randomUUID(), `s${i}`, at);
  }
  const e = jevChallengerEvidence(db, { JEV_CHALLENGER_MODEL: 'jev-1.14.0' });
  expect(e).toMatchObject({ mode: 'shadow', model: 'jev-1.14.0', status: 'ok', min_n: 20 });
  const j = e.by_judgment[0];
  expect(j).toMatchObject({ judgment: 'proposal_prescreen', model: 'jev-1.14.0', n_pairs: 25 });
  expect(j.agreement).toMatchObject({ k: 20, n: 25, rate: 0.8, status: 'ok' });
  expect(j.agreement.ci_low).toBeGreaterThan(0.5); expect(j.agreement.ci_high).toBeLessThan(1);
  expect(j.ground_truth.names_file?.primary).toMatchObject({ k: 25, n: 25, rate: 1 });
  expect(j.ground_truth.names_file?.challenger.k).toBe(22); // s0, s2, s4 answered 0.9 on a description without a path
  expect(j.ground_truth.d5_operator?.challenger).toMatchObject({ n: 3, rate: null, status: 'insufficient' });
  expect(j.ground_truth.relevance_blind).toBeNull();
  expect(jevChallengerEvidence(db, {})).toMatchObject({ mode: 'off', model: null });
});

it('readers ignore @-suffixed rows: D5-NO, forecastScores, funnel and stall watch see the same primary picture', () => {
  const at = new Date(Date.parse(D5NO_CUTOFF) + 3_600_000).toISOString();
  for (let i = 0; i < 12; i += 1) {
    proposal(`r${i}`, i % 3 ? 'regressed' : 'verified', at, 'change packages/server/src/x.ts');
    insert('proposal_prescreen', `r${i}`, 'no', at, NO);
  }
  const now = Date.parse(at) + 3_600_000;
  const before = { d5: JSON.stringify(d5NoEvidence(db, now)), fc: JSON.stringify(forecastScores(db, 3650)),
    funnel: JSON.stringify(new ImprovementFunnelService(db).judgmentAgreement().find((x) => x.judgment === 'proposal_prescreen')), stalls: detectStalls(db, now, {}).map((s) => s.subsystem) };
  const later = new Date(Date.parse(at) + 60_000).toISOString();
  for (let i = 0; i < 12; i += 1) {
    insert('proposal_prescreen@jev-1.14.0', `r${i}`, 'yes', later, YES);
    insert('proposal_prescreen@jev-1.14.0', `r${i}`, 'error', later, {}, 'shadow', `e${i}`);
  }
  expect(JSON.stringify(d5NoEvidence(db, now))).toBe(before.d5);
  expect(JSON.stringify(forecastScores(db, 3650))).toBe(before.fc);
  expect(JSON.stringify(new ImprovementFunnelService(db).judgmentAgreement().find((x) => x.judgment === 'proposal_prescreen'))).toBe(before.funnel);
  expect(detectStalls(db, now, {}).map((s) => s.subsystem)).toEqual(before.stalls);
  expect(detectStalls(db, now, {}).map((s) => s.subsystem)).not.toContain('judgment:proposal_prescreen@jev-1.14.0'); // 50 % errors, still not a stall
});
