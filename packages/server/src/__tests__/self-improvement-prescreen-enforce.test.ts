import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SelfImprovementService } from '../services/self-improvement-service';
import { SelfImprovementAutoReviewScheduler } from '../services/self-improvement-auto-review-scheduler';
import type { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';
import { decisionsInbox } from '../services/decisions-inbox';
import { requeueImprovement } from '../services/improvement-requeue';
import type { JudgmentRecord } from '../services/judgment-service';

// D5: the jev pre-screen's verdict is injected; everything else (modes, park, panel, requeue) is the real code
const judged = vi.hoisted(() => ({ next: null as null | (() => Promise<unknown>) }));
vi.mock('../services/judgment-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/judgment-service')>();
  return { ...actual, runJudgment: vi.fn((...args: unknown[]) => (judged.next ? judged.next() : actual.runJudgment(...(args as Parameters<typeof actual.runJudgment>)))) };
});

let db: Database.Database;
let improvements: SelfImprovementService;
const reviewMissingSpecialists = vi.fn(async () => undefined);
const scheduler = () => new SelfImprovementAutoReviewScheduler(db, { reviewMissingSpecialists } as unknown as SelfImprovementAgentReviewService);
const verdict = (decision: JudgmentRecord['decision'], mode: JudgmentRecord['mode'] = 'enforce') => {
  judged.next = async () => ({ id: 'j', decision, reason: 'names no concrete file', answers: {}, mode });
};
const propose = () => improvements.generateFromReflection({ whatFailed: [], lessonsLearned: [], proposedImprovements: ['Improve things somewhere in the platform'] })[0];

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  improvements = new SelfImprovementService(db);
  reviewMissingSpecialists.mockClear(); judged.next = null;
  vi.stubEnv('TYPESAFE_PROPOSAL_PRESCREEN_MODE', 'enforce');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

it('enforce + a confident no: parked as needs_more_evidence with the pre-screen reason, the panel is never called', async () => {
  const p = propose(); verdict('no');
  const result = await scheduler().tick();
  expect(reviewMissingSpecialists).not.toHaveBeenCalled();
  expect(result.parked).toEqual([p.id]);
  expect(improvements.getImprovement(p.id).status).toBe('needs_more_evidence');
  expect(db.prepare("SELECT mode, decision, reason FROM judgments WHERE judgment = 'prescreen_park' AND subject_id = ?").get(p.id))
    .toEqual({ mode: 'enforce', decision: 'no', reason: 'prescreen: names no concrete file' });
  // a parked proposal has no panel dissent: it never takes a refinement slot
  expect(improvements.getRefinementEligible(10)).toEqual([]);
});

it('a pre-screen-parked proposal is distinguishable in /decisions and requeue-able (D2)', async () => {
  const p = propose(); verdict('no');
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at)
    VALUES ('ps', 'proposal_prescreen', 'self_improvement', ?, 'h', 'enforce', 'no', 'names no concrete file', ?)`).run(p.id, new Date().toISOString());
  await scheduler().tick();
  expect(decisionsInbox(db).prescreen.items.find((i) => i.id === p.id)).toMatchObject({ status: 'needs_more_evidence', reason: 'prescreen: names no concrete file' });
  const copy = requeueImprovement(db, p.id, { actor: 'op', reason: 'pre-screen was wrong here' });
  expect(copy.created).toBe(true);
  expect(improvements.getImprovement(copy.id)).toMatchObject({ status: 'scheduled', approvedBy: 'op' });
});

it('a panel-parked proposal (no pre-screen park) is still not requeue-able', () => {
  const p = propose();
  db.prepare("UPDATE self_improvements SET status = 'needs_more_evidence' WHERE id = ?").run(p.id);
  expect(() => requeueImprovement(db, p.id, { actor: 'op', reason: 'try again please' })).toThrow('REQUEUE_STATUS_NOT_ALLOWED');
});

it.each([['yes'], ['uncertain']] as const)('enforce + %s: the panel runs as before', async (decision) => {
  const p = propose(); verdict(decision);
  await scheduler().tick();
  expect(reviewMissingSpecialists).toHaveBeenCalledTimes(1);
  expect(improvements.getImprovement(p.id).status).toBe('proposed');
});

it('enforce + a failed judgment (null / throw): fails open to the panel', async () => {
  const p = propose();
  judged.next = async () => null;
  await scheduler().tick();
  judged.next = async () => { throw new Error('jev down'); };
  await scheduler().tick();
  expect(reviewMissingSpecialists).toHaveBeenCalledTimes(2);
  expect(improvements.getImprovement(p.id).status).toBe('proposed');
});

it('shadow: a no is recorded only — the panel runs and nothing is parked', async () => {
  vi.stubEnv('TYPESAFE_PROPOSAL_PRESCREEN_MODE', 'shadow');
  const p = propose(); verdict('no', 'shadow');
  const result = await scheduler().tick();
  expect(reviewMissingSpecialists).toHaveBeenCalledTimes(1);
  expect(result.parked).toEqual([]);
  expect(improvements.getImprovement(p.id).status).toBe('proposed');
});

it('an oracle-lane proposal is never parked by the pre-screen and still skips the panel', async () => {
  vi.stubEnv('ORACLE_LANES_SKIP_PANEL', 'true');
  const p = improvements.generateFromGroundedGap({
    title: 'Raise the mutation score of services/x.ts', description: 'Edit only the test. RUNTIME COMMAND: npm run test:mutation:grounded', rationale: 'measured by one command',
    evidenceRef: 'mutation-gap:x', grounding: { target: 'packages/server/src/__tests__/x.test.ts', acceptanceTest: 'npm run test:mutation:grounded', runtimeCommand: 'npm run test:mutation:grounded', artifactPath: 'x.test.ts', budget: 'one maker lease' },
  })!;
  verdict('no');
  const result = await scheduler().tick();
  expect(reviewMissingSpecialists).not.toHaveBeenCalled();
  expect(result.parked).toEqual([]);
  expect(improvements.getImprovement(p.id)).toMatchObject({ status: 'scheduled', approvedBy: expect.stringMatching(/^agent:oracle-lane:/) });
});
