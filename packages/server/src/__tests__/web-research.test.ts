import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { genome } from '../services/genome-registry';
import { dreamOnce, guardLines } from '../services/dream-evolution';
import { buildSourcePack } from '../services/dream-evidence-sources';
import { knowledgeItem } from '../services/knowledge-fitness';
import { buildEvolutionEvidence, EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { REMOTE_GYM_SCOPE } from '../services/remote-gym-service';
import { createRemoteGymRoutes } from '../routes/remote-gym';
import { mintSpawnToken, resolveSpawnTokenSecret } from '../services/spawn-token';
import {
  claimWebResearch, failureClass, MAX_JOBS_PER_DAY, recordWebResearch, researchQuestion, researchQuestions, webResearchEvidence, webResearchMode,
} from '../services/web-research';

// WEB-001 (operator 2026-11-08): web input produced thousands of items and zero verified improvements — no consumer, no
// executed check. Research questions now come from measured failure signatures, run on the workstation (pull), and an
// accepted candidate becomes knowledge a dream genome can cite; the paired gym trial on the frozen holdout decides.

let db: Database.Database;
const NOW = new Date('2026-11-08T06:00:00Z');
const DAY = 86_400_000;
const ON = { WEB_RESEARCH_MODE: 'on' } as NodeJS.ProcessEnv;
const SHADOW = { WEB_RESEARCH_MODE: 'shadow' } as NodeJS.ProcessEnv;
const G = { guard: guardLines };

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  new SkillEvolutionEngine(db as never); // creates skill_outcomes
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

/** n failed production maker outcomes of one lane with a gate ref and a lease failure_reason (the failureSignature inputs). */
function failures(n: number, lane: string, gate: string, reason: string, prefix: string) {
  for (let i = 0; i < n; i++) {
    const run = `run-${prefix}-${i}`;
    db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, evidence_refs_json, created_at) VALUES (?, ?, 0, 'loop', ?, ?, ?)")
      .run(`o-${prefix}-${i}`, `loop-maker:${lane}`, run, JSON.stringify([`gate:${gate}:fail`]), new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString());
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata) VALUES (?, ?, 'maker', 'opencode', 'failed', ?)")
      .run(`l-${prefix}-${i}`, run, JSON.stringify({ failure_reason: reason }));
  }
}
function seedProdLike() {
  // the three most frequent production classes of 2026-11-01..08 (prod read-only query), plus private text in the reasons
  failures(8, 'doc-drift-and-small-fix-loop:opencode', 'maker_completion', 'maker_gate_failed:maker_runtime_exit_zero', 'exit');
  failures(6, 'doc-drift-and-small-fix-loop:opencode', 'maker_completion', 'deterministic_checks_failed:test:mutation:grounded(exit=1) in /home/djimit/ACME-Corp/invoice-7731.ts token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'mut');
  failures(2, 'doc-drift-and-small-fix-loop:remote', 'maker_completion', 'deterministic_checks_failed:test:changed(timed_out) after the target test passed', 'tmo');
  failures(5, 'test-gap:opencode', 'unknown_gate', 'something nobody can classify happened for customer Jane Doe', 'other');
}
const jobRows = () => db.prepare("SELECT * FROM judgments WHERE judgment = 'web_research' ORDER BY created_at, id").all() as Array<{ id: string; mode: string; decision: string; subject_id: string; answers_json: string }>;
const knowledgeRows = () => db.prepare("SELECT * FROM judgments WHERE judgment = 'web_research_knowledge'").all() as Array<{ id: string; subject_id: string; answers_json: string }>;
const candidate = (over: Record<string, unknown> = {}) => ({
  technique: 'Run the mutation report locally and add one assertion per surviving mutant on the changed function, before finishing.',
  sources: ['https://stryker-mutator.io/docs/stryker-js/introduction/'], strategy_line: 'Before finishing, kill each surviving mutant on the changed function with one precise assertion.', ...over,
});

it('WEB-001: the flag parses off|shadow|on (default off) and is registered as acting', () => {
  expect(webResearchMode({})).toBe('off');
  expect(webResearchMode({ WEB_RESEARCH_MODE: 'true' })).toBe('off');
  expect(webResearchMode(SHADOW)).toBe('shadow');
  expect(webResearchMode({ WEB_RESEARCH_MODE: ' On ' })).toBe('on');
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'WEB_RESEARCH_MODE', acting: true });
});

it('WEB-001: failure classes come from the gate + normalised error class; an unclassifiable failure asks nothing', () => {
  const sig = (error_class: string | null, gate: string | null = 'maker_completion') => ({ signature: 's', key: 'k', lane: 'l:opencode', gate, error_class });
  expect(failureClass(sig('maker_gate_failed:maker_runtime_exit_zero'))).toBe('runtime_exit_nonzero');
  expect(failureClass(sig('deterministic_checks_failed:test:mutation:grounded(exit=<n>)'))).toBe('mutation_check_failed');
  expect(failureClass(sig('deterministic_checks_failed:test:changed(timed_out)'))).toBe('check_timed_out');
  expect(failureClass(sig('out of scope: package.json, package-lock.json'))).toBe('package_json_out_of_scope');
  expect(failureClass(sig('out of scope: <path>'))).toBe('out_of_scope');
  expect(failureClass(sig('something else', 'weird_gate'))).toBeNull();
  expect(researchQuestion(sig('something else', 'weird_gate'), 3)).toBeNull();
});

it('WEB-001: the top ≤ 3 signatures by recent count become questions with only class, lane, runtime and stack — no private data', () => {
  seedProdLike();
  const qs = researchQuestions(db, NOW.getTime());
  expect(qs.map((q) => [q.failure_class, q.lane, q.runtime, q.occurrences])).toEqual([
    ['runtime_exit_nonzero', 'doc-drift-and-small-fix-loop', 'opencode', 8],
    ['mutation_check_failed', 'doc-drift-and-small-fix-loop', 'opencode', 6],
    ['check_timed_out', 'doc-drift-and-small-fix-loop', 'atomic-agent', 2],
  ]); // the unclassifiable 5x 'other' asks nothing
  for (const q of qs) {
    expect(q.question.length).toBeLessThanOrEqual(400);
    expect(q.question).toContain('TypeScript, vitest, Stryker, atomic-agent, opencode');
    expect(q.question).not.toMatch(/ACME|invoice|ghp_|djimit|Jane|7731|\/home/);
    for (const query of q.queries) expect(query).not.toMatch(/ACME|invoice|ghp_|djimit|Jane/);
  }
  expect(qs[1].question).toMatch(/Stryker mutation check fails/);
});

it('WEB-001: off asks nothing and writes nothing', () => {
  seedProdLike();
  expect(claimWebResearch(db, 'workstation', NOW, {})).toBeNull();
  expect(jobRows()).toEqual([]);
});

it('WEB-001: ≤ 1 job in flight, ≤ 3 per 24 h, a question is not asked again within 7 days, a stale claim expires', () => {
  seedProdLike();
  const a = claimWebResearch(db, 'workstation', NOW, SHADOW)!;
  expect(a).toMatchObject({ max_candidates: 3 });
  expect(a.question).toMatch(/non-zero status/);
  expect(claimWebResearch(db, 'workstation', new Date(NOW.getTime() + 60_000), SHADOW)).toBeNull(); // one in flight
  // the claim goes stale after 1 h: expired, and the next question is handed out
  const b = claimWebResearch(db, 'workstation', new Date(NOW.getTime() + 2 * 3_600_000), SHADOW)!;
  expect(b.question).toMatch(/mutation/);
  expect(jobRows().map((r) => r.decision)).toEqual(['expired', 'claimed']);
  return (async () => {
    await recordWebResearch(db, b.jobId, 'workstation', { status: 'done', candidates: [] }, SHADOW, NOW, G);
    const c = claimWebResearch(db, 'workstation', new Date(NOW.getTime() + 3 * 3_600_000), SHADOW)!;
    expect(c.question).toMatch(/times out/);
    await recordWebResearch(db, c.jobId, 'workstation', { status: 'failed', reason: 'no search results' }, SHADOW, NOW, G);
    expect(MAX_JOBS_PER_DAY).toBe(3);
    // three jobs in 24 h (one expired, one done, one failed): the cap holds even though nothing is in flight
    expect(claimWebResearch(db, 'workstation', new Date(NOW.getTime() + 4 * 3_600_000), SHADOW)).toBeNull();
    // next day: every question was asked within 7 days → nothing new to ask
    expect(claimWebResearch(db, 'workstation', new Date(NOW.getTime() + 2 * DAY), SHADOW)).toBeNull();
    expect(jobRows().map((r) => r.decision)).toEqual(['expired', 'done', 'failed']);
  })();
});

it('WEB-001 shadow: one judgments row per job records the question and what came back; nothing is routed into dream evidence', async () => {
  seedProdLike();
  const job = claimWebResearch(db, 'workstation', NOW, SHADOW)!;
  const r = await recordWebResearch(db, job.jobId, 'workstation', { status: 'done', model: 'qwen-local', search: { provider: 'searxng', results: 7 }, candidates: [candidate()] }, SHADOW, NOW, G);
  expect(r).toEqual({ returned: 1, accepted: 1, rejected: {}, routed: 0 });
  const [row] = jobRows();
  expect(row).toMatchObject({ mode: 'shadow', decision: 'done' });
  const a = JSON.parse(row.answers_json);
  expect(a).toMatchObject({ question: job.question, failure_class: 'runtime_exit_nonzero', returned: 1, accepted: 1, rejected: {}, search: { provider: 'searxng', results: 7 } });
  expect(a.candidates[0]).toMatchObject({ decision: 'accepted', knowledge_ref: null, sources: ['https://stryker-mutator.io/docs/stryker-js/introduction/'] });
  expect(knowledgeRows()).toEqual([]);
  expect(buildSourcePack(db, ['knowledge'], ['doc-drift-and-small-fix-loop'], NOW.getTime(), SHADOW).items).toEqual([]);
  // a result for another host, a second result, an unknown job: refused
  await expect(recordWebResearch(db, job.jobId, 'other-host', { status: 'done', candidates: [] }, SHADOW, NOW, G)).rejects.toThrow('RESEARCH_JOB_NOT_FOUND');
  await expect(recordWebResearch(db, job.jobId, 'workstation', { status: 'done', candidates: [] }, SHADOW, NOW, G)).rejects.toThrow('RESEARCH_JOB_NOT_CLAIMED');
  await expect(recordWebResearch(db, 'nope', 'workstation', { status: 'done', candidates: [] }, SHADOW, NOW, G)).rejects.toThrow('RESEARCH_JOB_NOT_FOUND');
});

it('WEB-001: every candidate is untrusted — guardLines, the NE registry, secrets, sources, size and content safety reject it', async () => {
  vi.stubEnv('CONTENT_SAFETY_MODE', 'enforce'); // no NVIDIA key: no verdict → enforce excludes
  seedProdLike();
  const job = claimWebResearch(db, 'workstation', NOW, ON)!;
  const ne = [{ id: 'NE-099', verdict: 'REJECT', reopen_condition: 'x', match_terms: ['jev prescreen'] }];
  const r = await recordWebResearch(db, job.jobId, 'workstation', { status: 'done', candidates: [
    candidate({ strategy_line: 'Skip the failing test when it is slow.' }),
    candidate({ sources: ['javascript:alert(1)'] }),
    candidate({ technique: 'x'.repeat(601) }),
    candidate(), candidate({ sources: [] }), // beyond the 3 a job may return: never screened, never stored
  ] }, ON, NOW, { guard: guardLines, neEntries: ne });
  expect(r).toEqual({ returned: 5, accepted: 0, routed: 0, rejected: { guard: 1, no_source: 1, malformed: 1, over_cap: 2 } });
  const job1b = claimWebResearch(db, 'workstation', new Date(NOW.getTime() + 3_600_000), ON)!;
  expect(await recordWebResearch(db, job1b.jobId, 'workstation', { status: 'done', candidates: [candidate({ sources: [] }), candidate({ strategy_line: `Use ${'a'.repeat(200)}` })] }, ON, NOW, { guard: guardLines, neEntries: ne }))
    .toMatchObject({ rejected: { no_source: 1, malformed: 1 } });
  const job2 = claimWebResearch(db, 'workstation', new Date(NOW.getTime() + 2 * 3_600_000), ON)!;
  await recordWebResearch(db, job2.jobId, 'workstation', { status: 'done', candidates: [
    candidate({ technique: 'Configure a jev prescreen cascade before each maker run.' }),
    candidate({ technique: 'Put the key ghp_abcdefghijklmnopqrstuvwxyz0123456789 into the runner env.' }),
    candidate(),
  ] }, ON, new Date(NOW.getTime() + 2 * 3_600_000), { guard: guardLines, neEntries: ne });
  const a = JSON.parse(jobRows()[2].answers_json);
  expect(a.rejected).toEqual({ negative_evidence: 1, secret: 1, content_safety: 1 });
  expect(a.candidates.find((c: { reason: string }) => c.reason === 'secret').technique).not.toContain('ghp_'); // stored redacted
  expect(knowledgeRows()).toEqual([]);
});

it('WEB-001 on: an accepted candidate becomes knowledge with provenance, the dream can cite it, and evidence follows it to the trial', async () => {
  vi.stubEnv('WEB_RESEARCH_MODE', 'on'); vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true'); vi.stubEnv('DREAM_EVIDENCE_SOURCES', 'knowledge');
  seedProdLike();
  const off = buildEvolutionEvidence(db, {}, NOW.getTime()).web_research;
  expect(off).toMatchObject({ mode: 'off', questions: null, candidates: null, routed: null, cited: null }); // unknown, never 0
  failures(1, 'doc-drift-and-small-fix-loop:opencode', 'maker_completion', 'maker_gate_failed:maker_runtime_exit_zero', 'late');
  const job = claimWebResearch(db, 'workstation', NOW, ON)!;
  const r = await recordWebResearch(db, job.jobId, 'workstation', { status: 'done', model: 'qwen-local', candidates: [candidate(), candidate({ technique: 'Duplicate line, other words.' })] }, ON, NOW, G);
  expect(r).toEqual({ returned: 2, accepted: 1, rejected: { duplicate: 1 }, routed: 1 });
  const [k] = knowledgeRows();
  const ka = JSON.parse(k.answers_json);
  expect(ka).toMatchObject({ ref: `knowledge:web:${k.id}`, question: job.question, failure_signature: k.subject_id, job_id: job.jobId,
    sources: ['https://stryker-mutator.io/docs/stryker-js/introduction/'], strategy_line: candidate().strategy_line });
  expect(knowledgeItem(ka.ref)).toEqual({ kind: 'knowledge', id: ka.ref }); // K1 can credit it once a genome cites it

  const pack = buildSourcePack(db, ['knowledge'], ['doc-drift-and-small-fix-loop'], NOW.getTime(), ON);
  expect(pack.items).toEqual([{ id: ka.ref, source: 'knowledge', ref: ka.ref, text: expect.stringContaining('unverified web technique') }]);
  expect(buildSourcePack(db, ['skills'], [], NOW.getTime(), ON).items).toEqual([]); // only through the knowledge source

  // a gym failure gives the dream something to learn from; the mutant cites the web knowledge
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('f1', 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`)
    .run(JSON.stringify({ gym: { commit: 'c1', source: 'packages/server/src/services/x.ts' }, gym_result: { status: 'failure', reason: 'tests still red' } }), NOW.toISOString(), NOW.toISOString());
  const call = vi.fn(async () => JSON.stringify({ mutants: [{ gene: 'strategy_lines', lines: [{ text: 'Kill each surviving mutant on the changed function with one assertion.', cites: [ka.ref] }] }] }));
  const { created } = await dreamOnce(db, NOW.getTime() + 3_600_000, call);
  expect(call.mock.calls[0][0]).toContain(`[${ka.ref}] unverified web technique`);
  expect(created).toHaveLength(1);
  expect(genome(db, created[0])!.status).toBe('trial');
  expect(db.prepare('SELECT evidence_sources_json s, knowledge_refs_json k FROM maker_genomes WHERE id = ?').get(created[0]))
    .toEqual({ s: JSON.stringify([{ source: 'knowledge', id: ka.ref }]), k: JSON.stringify([ka.ref]) });

  const ev = webResearchEvidence(db, ON, NOW.getTime() + 3_600_000);
  expect(ev).toMatchObject({ mode: 'on', questions: { asked: 1, by_status: { done: 1 } }, candidates: { returned: 2, accepted: 1, rejected_by_reason: { duplicate: 1 } }, routed: 1,
    cited: { genomes: 1, promoted: 0, retired: 0, inconclusive: 0, pending: 1 } });
  expect(ev.cited!.list[0]).toMatchObject({ genome: created[0], status: 'trial', knowledge: [ka.ref], trial: null });
  // the paired trial settles: its verdict row shows up next to the genome
  db.prepare("UPDATE maker_genomes SET status = 'retired' WHERE id = ?").run(created[0]);
  db.prepare("INSERT INTO genome_trial_results (trial_id, parent_id, tier_set, deciding_n, b, c, p, state, recorded_at) VALUES (?, 'g-baseline', '2,3', 20, 1, 3, 0.94, 'retired', ?)").run(created[0], NOW.toISOString());
  const settled = buildEvolutionEvidence(db, ON, NOW.getTime() + 3_600_000).web_research;
  expect(settled.cited).toMatchObject({ genomes: 1, retired: 1, pending: 0 });
  expect(settled.cited!.list[0].trial).toMatchObject({ state: 'retired', b: 1, c: 3, p: 0.94 });
});

it('WEB-001: a caller that passes no guard gets every line refused (fail closed)', async () => {
  seedProdLike();
  const job = claimWebResearch(db, 'workstation', NOW, ON)!;
  expect(await recordWebResearch(db, job.jobId, 'workstation', { status: 'done', candidates: [candidate()] }, ON, NOW)).toEqual({ returned: 1, accepted: 0, rejected: { guard: 1 }, routed: 0 });
});

it('WEB-001 on → off: routed knowledge stops reaching the pack', async () => {
  seedProdLike();
  const job = claimWebResearch(db, 'workstation', NOW, ON)!;
  await recordWebResearch(db, job.jobId, 'workstation', { status: 'done', candidates: [candidate()] }, ON, NOW, G);
  expect(buildSourcePack(db, ['knowledge'], [], NOW.getTime(), ON).items).toHaveLength(1);
  expect(buildSourcePack(db, ['knowledge'], [], NOW.getTime(), SHADOW).items).toEqual([]);
  expect(buildSourcePack(db, ['knowledge'], [], NOW.getTime(), {}).items).toEqual([]);
});

// ---- the pull routes (host token, like the committee) ----
const pass = (_req: unknown, _res: unknown, next: () => void) => next();
const app = () => express().use(express.json()).use('/gym-worker', createRemoteGymRoutes(db, { requireAuth: pass, requirePermission: () => pass } as never));

it('WEB-001 routes: off answers 204 without DB work; on needs the research_jobs capability; the result goes back to the same host', async () => {
  vi.stubEnv('JWT_SECRET', 'test-secret-web-research');
  seedProdLike();
  const token = mintSpawnToken(resolveSpawnTokenSecret(), 'workstation', REMOTE_GYM_SCOPE, 60_000);
  const a = app(); // built before the spy: the router's services prepare their tables at construction
  const post = (path: string, body: unknown, t = token) => request(a).post(path).set('X-Gym-Host', 'workstation').set('X-Gym-Worker-Token', t).send(body as object);
  const prepare = vi.spyOn(db, 'prepare');
  expect((await post('/gym-worker/research/claim', { capabilities: ['research_jobs'] }).expect(204)).text).toBe('');
  await post('/gym-worker/research/claim', {}, 'nope').expect(401);
  expect(prepare).not.toHaveBeenCalled();
  prepare.mockRestore();
  vi.stubEnv('WEB_RESEARCH_MODE', 'shadow');
  expect((await post('/gym-worker/research/claim', { capabilities: [] }).expect(200)).body).toEqual({ job: null });
  const { job } = (await post('/gym-worker/research/claim', { capabilities: ['research_jobs'] }).expect(200)).body;
  expect(job).toMatchObject({ jobId: expect.any(String), max_candidates: 3, queries: expect.any(Array) });
  expect((await post(`/gym-worker/research/${job.jobId}/result`, { status: 'done', candidates: [candidate()] }).expect(200)).body).toEqual({ recorded: { returned: 1, accepted: 1, rejected: {}, routed: 0 } });
  await post(`/gym-worker/research/${job.jobId}/result`, { status: 'done', candidates: [] }).expect(409);
  await post('/gym-worker/research/nope/result', { status: 'done', candidates: [] }).expect(404);
});
