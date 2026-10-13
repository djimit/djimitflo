import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { runJudgment, runJudgments, type JudgmentDef } from '../services/judgment-service';
import type { TypeSafeClient, TsAnswer, TsQuestion } from '../services/typesafe-client';
import { discoveryRelevance } from '../services/judgments/discovery-relevance';
import { checkerSecondOpinion } from '../services/judgments/checker-second-opinion';
import { proposalPrescreen } from '../services/judgments/proposal-prescreen';
import { gatePassages } from '../services/kb-corpus';

// E2 invariant: no valid observation ≠ negative observation. At the shared jev boundary (runJudgment / runJudgments) a
// generation, parse or infra failure — or a response whose answers are missing or malformed — never yields a semantic
// 'yes' or 'no': it is an error row (no decision) or 'uncertain' (insufficient evidence). Valid responses still decide.
let db: Database.Database; const env = { ...process.env };
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  Object.assign(process.env, {
    TYPESAFE_API_KEY: 'test', TYPESAFE_DISCOVERY_RELEVANCE_MODE: 'shadow', TYPESAFE_CHECKER_SECOND_OPINION_MODE: 'shadow',
    TYPESAFE_PROPOSAL_PRESCREEN_MODE: 'enforce', TYPESAFE_KB_PASSAGE_RELEVANCE_MODE: 'enforce', TYPESAFE_JUDGE_A_MODE: 'shadow', TYPESAFE_JUDGE_B_MODE: 'shadow',
  });
});
afterEach(() => { db.close(); process.env = { ...env }; });

const answering = (answers: Record<string, TsAnswer>) => ({ systemOne: async () => ({ model: 'jev-1.13.0', answers }) }) as unknown as TypeSafeClient;
const failing = (message: string) => ({ systemOne: async () => { throw new Error(message); } }) as unknown as TypeSafeClient;
const rows = () => db.prepare('SELECT judgment, decision, reason, error FROM judgments ORDER BY created_at').all() as Array<{ judgment: string; decision: string; reason: string | null; error: string | null }>;

describe('jev judgment boundary', () => {
  it('an infra failure is an error row with no semantic decision', async () => {
    const r = await runJudgment(db, discoveryRelevance, { type: 'd', id: '1' }, { title: 't' }, failing('TYPESAFE_QUEUE_FULL'));
    expect(r).toBeNull();
    expect(rows()).toEqual([expect.objectContaining({ decision: 'error', error: 'TYPESAFE_QUEUE_FULL' })]);
  });

  it('a missing answer is insufficient evidence, not a negative decision (discovery_relevance)', async () => {
    // a confident open_problem but no `actionable` answer: decide() reads the missing answer as 0 → 'no' on main
    const r = await runJudgment(db, discoveryRelevance, { type: 'd', id: '1' }, { title: 't' },
      answering({ relevance: { type: 'choice', choice: 'open_problem', confidence: 0.95 } }));
    expect(r?.decision).toBe('uncertain');
    expect(r?.reason).toMatch(/^insufficient_evidence/);
    expect(rows()[0].decision).toBe('uncertain');
  });

  it('a malformed answer (NaN confidence, choice outside the criteria, noul out of range) never decides', async () => {
    const nanConfidence = await runJudgment(db, checkerSecondOpinion, { type: 'l', id: '1' }, {},
      answering({ verdict: { type: 'choice', choice: 'rejected', confidence: Number.NaN }, tests_named_behaviour: { type: 'noul', noul: 0.9 }, weakens_assertions: { type: 'noul', noul: 0.1 }, trivial_tests: { type: 'noul', noul: 0.1 } }),
      { checkerVerdict: 'accepted' });
    expect(nanConfidence?.decision).toBe('uncertain');
    const unknownChoice = await runJudgment(db, discoveryRelevance, { type: 'd', id: '2' }, {},
      answering({ relevance: { type: 'choice', choice: 'banana', confidence: 0.99 }, actionable: { type: 'noul', noul: 0.9 } }));
    expect(unknownChoice?.decision).toBe('uncertain');
    const outOfRange = await runJudgment(db, proposalPrescreen, { type: 's', id: '3' }, {},
      answering({ names_file: { type: 'noul', noul: -3 }, verifiable: { type: 'noul', noul: 0.9 }, concrete: { type: 'noul', noul: 0.9 }, sensitive: { type: 'noul', noul: 0.1 } }));
    expect(outOfRange?.decision).toBe('uncertain'); // enforce: an uncertain pre-screen fails open to the panel, never parks
  });

  it('checker_second_opinion: a confident accept with the atomic answers missing is not an acceptance', async () => {
    const r = await runJudgment(db, checkerSecondOpinion, { type: 'l', id: 'm1' }, {},
      answering({ verdict: { type: 'choice', choice: 'accepted', confidence: 0.9 } }), { checkerVerdict: 'accepted' });
    expect(r?.decision).toBe('uncertain');
    expect(r?.reason).toContain('trivial_tests');
  });

  it('valid answers are still evaluated: a complete, confident response decides yes / no as before', async () => {
    const yes = await runJudgment(db, discoveryRelevance, { type: 'd', id: '1' }, {},
      answering({ relevance: { type: 'choice', choice: 'lane_technique', confidence: 0.9 }, actionable: { type: 'noul', noul: 0.8 } }));
    const no = await runJudgment(db, discoveryRelevance, { type: 'd', id: '2' }, {},
      answering({ relevance: { type: 'choice', choice: 'off_topic', confidence: 0.9 }, actionable: { type: 'noul', noul: 0.1 } }));
    expect([yes?.decision, no?.decision]).toEqual(['yes', 'no']);
    const parked = await runJudgment(db, proposalPrescreen, { type: 's', id: '3' }, {},
      answering({ names_file: { type: 'noul', noul: 0.05 }, verifiable: { type: 'noul', noul: 0.9 }, concrete: { type: 'noul', noul: 0.9 }, sensitive: { type: 'noul', noul: 0.1 } }));
    expect(parked?.decision).toBe('no');
  });

  it('batched (runJudgments): a judgment whose answers are absent from the shared response is uncertain, the others decide', async () => {
    const def = (id: string): JudgmentDef => ({ id, questions: { x: { type: 'noul', instructions: id } }, decide: (a) => ({ decision: (a.x?.noul ?? 0) > 0.5 ? 'yes' : 'no', reason: 'r' }) });
    const client = { systemOne: async (_s: unknown, q: Record<string, TsQuestion>) => ({ model: 'jev', answers: Object.fromEntries(Object.keys(q).filter((k) => k.startsWith('judge_a')).map((k) => [k, { type: 'noul', noul: 0.9 }])) }) } as unknown as TypeSafeClient;
    const [a, b] = await runJudgments(db, [def('judge_a'), def('judge_b')], { type: 's', id: '1' }, {}, client);
    expect(a?.decision).toBe('yes');
    expect(b?.decision).toBe('uncertain');
  });

  it('batched infra failure: one error row per judgment, no decision', async () => {
    const def = (id: string): JudgmentDef => ({ id, questions: { x: { type: 'noul', instructions: id } }, decide: () => ({ decision: 'no', reason: 'r' }) });
    const out = await runJudgments(db, [def('judge_a'), def('judge_b')], { type: 's', id: '1' }, {}, failing('timeout'));
    expect(out).toEqual([null, null]);
    expect(rows().map((r) => r.decision)).toEqual(['error', 'error']);
  });
});

describe('knowledge relevance (kb_passage_relevance / discovery_relevance)', () => {
  const pages = [{ path: 'a.md', title: 'A', body: 'a' }, { path: 'b.md', title: 'B', body: 'b' }];

  it('kb_passage_relevance: a jev error keeps every page (no page is judged irrelevant)', async () => {
    const kept = await gatePassages(db, { type: 'p', id: '1' }, 'q', pages, failing('TYPESAFE_BREAKER_OPEN'));
    expect([...kept].sort()).toEqual(['a.md', 'b.md']);
    expect(rows().every((r) => r.decision === 'error')).toBe(true);
  });

  it('kb_passage_relevance enforce: a missing or malformed page answer keeps that page; a valid low answer drops its page', async () => {
    const kept = await gatePassages(db, { type: 'p', id: '1' }, 'q', [...pages, { path: 'c.md', title: 'C', body: 'c' }],
      answering({ p0: { type: 'noul', noul: 0.1 }, p1: { type: 'noul', noul: Number.NaN } }));
    expect([...kept].sort()).toEqual(['b.md', 'c.md']);
    expect(rows()[0].decision).toBe('uncertain');
  });

  it('discovery_relevance: an infra error records no "no" for the discovery', async () => {
    await runJudgment(db, discoveryRelevance, { type: 'discovery_pending', id: 'x' }, {}, failing('fetch failed'));
    expect(db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'discovery_relevance' AND decision = 'no'").get()).toEqual({ n: 0 });
  });
});
