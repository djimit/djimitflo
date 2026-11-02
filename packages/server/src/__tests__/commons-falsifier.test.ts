import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { EVOLUTION_FLAGS, buildEvolutionEvidence } from '../services/evolution-evidence';
import { parseArtefact, replyToEvidenceRoom, sweepEvidenceRoom } from '../services/commons-evidence-room';
import {
  classifyReport, falsifierEvidence, falsifierTick, guardSubmission, repoImports, type FalsifierDeps, type RunResult, type Submission,
} from '../services/commons-falsifier';

const DAY = 86_400_000;
const SECRET = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;
const ROOM = { COMMONS_EVIDENCE_ROOM_MODE: 'on' } as NodeJS.ProcessEnv;
const ENV = { COMMONS_EVIDENCE_ROOM_MODE: 'on', COMMONS_FALSIFIER_MODE: 'shadow', COMMONS_FALSIFIER_AGENTS: '*', LOOP_DAEMON_REPOSITORY_PATH: '/repo' } as NodeJS.ProcessEnv;
const FILE = 'packages/server/src/__tests__/foo-falsifier.test.ts';
const GOOD = "import { describe, it, expect } from 'vitest';\nimport { foo } from '../services/foo';\ndescribe('foo', () => { it('adds', () => { expect(foo(1, 2)).toBe(3); }); });\n";
let db: Database.Database;

function seedRoom() {
  db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, grounding_json) VALUES ('si-r1', 'test', 't', 'd', 'r', 'gap_analysis', 'verified', '{}')").run();
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, improvement_id) VALUES ('g-r1', 'o', 'low', 'completed', 'si-r1')").run();
  db.prepare("INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, metadata, created_at) VALUES ('r1', 'g-r1', 'test-gap', 'closed', 'completed', '[]', '{}', ?)").run(new Date(Date.now() - DAY).toISOString());
  db.prepare("INSERT INTO skill_outcomes (id, skill_id, success, domain, task_id, agent_id, evidence_refs_json, created_at) VALUES ('o1', 'loop-maker:test-gap:claude', 1, 'test-gap', 'r1', null, '[]', ?)").run(new Date(Date.now() - DAY).toISOString());
  sweepEvidenceRoom(db, Date.now(), ROOM);
}
const submit = (agent: string, content = GOOD, testFile = FILE) =>
  replyToEvidenceRoom(db, 'evidence-room:r1', agent, { text: 'falsifies foo', artefact: { kind: 'test', test_file: testFile, command: `npx vitest run ${testFile}`, content } }, ROOM);

/** A fake repo: main moves when the test says so; each sha has a verdict for the test. */
function fakeDeps(state: { main: string; verdicts: Record<string, RunResult>; changed?: string[] | null; existing?: string[] }) {
  const calls: Array<{ sha: string; sub: Submission }> = [];
  const deps: FalsifierDeps = {
    mainSha: () => state.main,
    exists: (_r, _s, f) => (state.existing ?? []).includes(f),
    changedBetween: () => (state.changed === undefined ? ['packages/server/src/services/foo.ts'] : state.changed),
    run: async (_r, sha, sub) => { calls.push({ sha, sub }); return state.verdicts[sha] ?? { verdict: 'unknown', reason: 'infra: no verdict' }; },
  };
  return { deps, calls };
}
const outcomes = () => db.prepare("SELECT skill_id, success, agent_id, domain, evidence_refs_json FROM skill_outcomes WHERE domain = 'falsifier'").all() as Array<{ skill_id: string; success: number; agent_id: string; domain: string; evidence_refs_json: string }>;

beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  db.exec(`CREATE TABLE IF NOT EXISTS skill_outcomes (id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, success INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0, domain TEXT NOT NULL DEFAULT '', task_id TEXT, agent_id TEXT, model TEXT, evidence_refs_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)`);
  seedRoom();
});
afterEach(() => db.close());

describe('Commons falsifier niche (AR5)', () => {
  it('is a registered, non-acting evolution flag with a falsifier evidence section', () => {
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'COMMONS_FALSIFIER_MODE', acting: false });
    expect(Object.keys(buildEvolutionEvidence(db, {}))).toContain('falsifier');
  });

  it('carries the test content on the existing typed evidence-room artefact and refuses a secret in it', () => {
    expect(parseArtefact({ kind: 'test', test_file: FILE, command: 'npx vitest run x', content: GOOD })).toEqual({ kind: 'test', test_file: FILE, command: 'npx vitest run x', content: GOOD });
    expect(parseArtefact({ kind: 'test', test_file: FILE, command: 'npx vitest run x' })).toEqual({ kind: 'test', test_file: FILE, command: 'npx vitest run x' });
    expect(() => parseArtefact({ kind: 'test', test_file: FILE, command: 'c', content: `const t = '${SECRET}';` })).toThrow('EVIDENCE_ARTEFACT_CONTENT_SECRET');
    expect(() => parseArtefact({ kind: 'test', test_file: FILE, command: 'c', content: 'x'.repeat(20_001) })).toThrow('EVIDENCE_ARTEFACT_CONTENT_INVALID');
    expect(submit('agent-a').artefact).toMatchObject({ content: GOOD });
  });

  it('off: runs nothing and reports nulls, not zeros', async () => {
    submit('agent-a');
    const { deps, calls } = fakeDeps({ main: 'sha1', verdicts: { sha1: { verdict: 'red', reason: '1 failed' } } });
    expect((await falsifierTick(db, deps, Date.now(), { ...ENV, COMMONS_FALSIFIER_MODE: 'off' })).skipped).toBe('off');
    expect(calls).toHaveLength(0);
    expect(falsifierEvidence(db, {})).toMatchObject({ mode: 'off', status: 'insufficient', totals: null, by_agent: null, executions_24h: null });
  });

  it('red at base, then green on a later main that changed an imported module: one success outcome for the submitting agent', async () => {
    submit('agent-a');
    const state = { main: 'sha1', verdicts: { sha1: { verdict: 'red', reason: '1 of 1 test(s) failed' }, sha2: { verdict: 'green', reason: '1 passed' } } as Record<string, RunResult> };
    const { deps, calls } = fakeDeps(state);
    const t0 = Date.now();
    expect(await falsifierTick(db, deps, t0, ENV)).toMatchObject({ executed: 1, settled: 0 });
    expect(await falsifierTick(db, deps, t0 + 3_600_000, ENV)).toMatchObject({ executed: 0 }); // main has not moved: no re-run
    state.main = 'sha2';
    expect(await falsifierTick(db, deps, t0 + DAY, ENV)).toMatchObject({ executed: 1, settled: 1 });
    expect(calls.map((c) => c.sha)).toEqual(['sha1', 'sha2']);
    expect(calls[0].sub).toMatchObject({ agent: 'agent-a', test_file: FILE, content: GOOD });
    const o = outcomes();
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ skill_id: 'falsifier:agent-a', success: 1, agent_id: 'agent-a' });
    expect(JSON.parse(o[0].evidence_refs_json)).toEqual(expect.arrayContaining(['falsifier_red:sha1', 'falsifier_green:sha2', `test:${FILE}`]));
    state.main = 'sha3';
    expect(await falsifierTick(db, deps, t0 + 2 * DAY, ENV)).toMatchObject({ executed: 0 }); // settled once
    expect(outcomes()).toHaveLength(1);
  });

  it('green at base earns nothing and is not a negative; infra unknowns are retried and never a negative', async () => {
    submit('agent-green');
    submit('agent-infra', GOOD, 'packages/server/src/__tests__/bar-falsifier.test.ts');
    const { deps } = fakeDeps({ main: 'sha1', verdicts: {} });
    deps.run = async (_r, _sha, sub) => (sub.agent === 'agent-green' ? { verdict: 'green', reason: '1 passed' } : { verdict: 'unknown', reason: 'infra: npm ci failed' });
    const t0 = Date.now();
    await falsifierTick(db, deps, t0, ENV);
    await falsifierTick(db, deps, t0 + 3_600_000, ENV);
    expect(outcomes()).toEqual([]);
    const ev = falsifierEvidence(db, ENV, t0 + 3_600_000);
    expect(ev.by_agent).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'agent-green', green_at_base: 1, red_at_base: 0, unknown: 0 }),
      expect.objectContaining({ agent: 'agent-infra', unknown: 1, red_at_base: 0, green_at_base: 0 }),
    ]));
    expect(ev.executions_24h).toBe(3); // green once; infra retried (≤ 3 base attempts)
  });

  it('a pass with no change to an imported module (time bomb, flake) does not settle', async () => {
    submit('agent-a');
    const state = { main: 'sha1', verdicts: { sha1: { verdict: 'red', reason: 'failed' }, sha2: { verdict: 'green', reason: 'passed' } } as Record<string, RunResult>, changed: ['README.md'] };
    const { deps } = fakeDeps(state);
    await falsifierTick(db, deps, Date.now(), ENV);
    state.main = 'sha2';
    expect((await falsifierTick(db, deps, Date.now() + DAY, ENV)).settled).toBe(0);
    expect(outcomes()).toEqual([]);
    expect(falsifierEvidence(db, ENV, Date.now() + DAY).totals).toMatchObject({ red_at_base: 1, unknown: 1, settled_green: 0 });
  });

  it('re-checks for 14 days only', async () => {
    submit('agent-a');
    const state = { main: 'sha1', verdicts: { sha1: { verdict: 'red', reason: 'failed' }, sha2: { verdict: 'green', reason: 'passed' } } as Record<string, RunResult> };
    const { deps, calls } = fakeDeps(state);
    const t0 = Date.now();
    await falsifierTick(db, deps, t0, ENV);
    state.main = 'sha2';
    expect((await falsifierTick(db, deps, t0 + 15 * DAY, ENV)).executed).toBe(0);
    expect(calls).toHaveLength(1);
    expect(falsifierEvidence(db, ENV, t0 + 15 * DAY).totals).toMatchObject({ expired: 1, settled_green: 0 });
  });

  it('guards: non-test paths, existing files, no repo import, no assertions, secrets, non-allowlisted agents and operators never run', async () => {
    submit('agent-a', GOOD, 'packages/server/src/services/foo.test.ts'); // not under a test directory
    submit('agent-a', "import { it } from 'vitest';\nit('x', () => { expect(1).toBe(1); });\n", 'packages/server/src/__tests__/noimport.test.ts');
    submit('agent-a', "import { foo } from '../services/foo';\nit('x', () => { foo(); });\n", 'packages/server/src/__tests__/noassert.test.ts');
    submit('agent-a', GOOD, 'packages/server/src/__tests__/exists.test.ts');
    submit('operator:u1', GOOD, 'packages/server/src/__tests__/op.test.ts');
    submit('agent-unlisted', GOOD, 'packages/server/src/__tests__/unlisted.test.ts');
    const { deps, calls } = fakeDeps({ main: 'sha1', verdicts: {}, existing: ['packages/server/src/__tests__/exists.test.ts'] });
    const r = await falsifierTick(db, deps, Date.now(), { ...ENV, COMMONS_FALSIFIER_AGENTS: 'agent-a' });
    expect(r).toMatchObject({ executed: 0, rejected: 4 });
    expect(calls).toHaveLength(0);
    const reasons = (db.prepare('SELECT test_file, reason FROM commons_falsifier_runs ORDER BY test_file').all() as Array<{ test_file: string; reason: string }>).map((x) => x.reason);
    expect(reasons.join('|')).toMatch(/already exists on main/);
    expect(reasons.join('|')).toMatch(/imports nothing/);
    expect(reasons.join('|')).toMatch(/0 expect\(\) assertions|no assertions/);
    expect(reasons.join('|')).toMatch(/not a test file under a package test directory/);
    expect(guardSubmission({ message_id: 'm', agent: 'a', test_file: FILE, content: `${GOOD}// ${SECRET}`, submitted_at: '' })).toMatch(/secret/);
    expect(repoImports(FILE, GOOD)).toEqual(['packages/server/src/services/foo']);
    expect(repoImports(FILE, "import { x } from '@djimitflo/shared';")).toEqual(['packages/shared']);
  });

  it('caps executions at COMMONS_FALSIFIER_MAX_PER_DAY per 24 h', async () => {
    for (let i = 0; i < 7; i++) submit(`agent-${i}`, GOOD, `packages/server/src/__tests__/f${i}.test.ts`);
    const { deps, calls } = fakeDeps({ main: 'sha1', verdicts: { sha1: { verdict: 'red', reason: 'failed' } } });
    const t0 = Date.now();
    expect((await falsifierTick(db, deps, t0, ENV)).executed).toBe(5);
    expect((await falsifierTick(db, deps, t0 + 3_600_000, ENV)).executed).toBe(0);
    expect((await falsifierTick(db, deps, t0 + DAY + 1, ENV)).executed).toBe(2);
    expect(calls).toHaveLength(7);
  });

  it('evidence is insufficient below 5 submissions and ok from 5, with per-agent counts', async () => {
    const { deps } = fakeDeps({ main: 'sha1', verdicts: { sha1: { verdict: 'red', reason: 'failed' } } });
    for (let i = 0; i < 4; i++) submit('agent-a', GOOD, `packages/server/src/__tests__/e${i}.test.ts`);
    await falsifierTick(db, deps, Date.now(), ENV);
    expect(falsifierEvidence(db, ENV)).toMatchObject({ status: 'insufficient', totals: { submitted: 4, red_at_base: 4 }, settle_rate: null });
    submit('agent-b', GOOD, 'packages/server/src/__tests__/e4.test.ts');
    const ev = falsifierEvidence(db, ENV);
    expect(ev).toMatchObject({ status: 'ok', totals: { submitted: 5, red_at_base: 4, pending: 5 } });
    expect(ev.by_agent?.map((a) => [a.agent, a.submitted])).toEqual([['agent-a', 4], ['agent-b', 1]]);
  });

  it('classifies the vitest JSON report: only an executed failing test is red', () => {
    expect(classifyReport({ numTotalTests: 2, numFailedTests: 1, numPassedTests: 1, numFailedTestSuites: 1 }, 1, false).verdict).toBe('red');
    expect(classifyReport({ numTotalTests: 1, numFailedTests: 0, numPassedTests: 1, numFailedTestSuites: 0 }, 0, false).verdict).toBe('green');
    expect(classifyReport({ numTotalTests: 0, numFailedTests: 0, numPassedTests: 0, numFailedTestSuites: 1 }, 1, false)).toMatchObject({ verdict: 'unknown', reason: expect.stringMatching(/no test ran/) });
    expect(classifyReport(null, 1, false).verdict).toBe('unknown');
    expect(classifyReport({ numTotalTests: 1, numFailedTests: 1 }, 1, true)).toEqual({ verdict: 'unknown', reason: 'timeout' });
    expect(classifyReport({ numTotalTests: 1, numFailedTests: 0, numPassedTests: 1, numFailedTestSuites: 1 }, 1, false).verdict).toBe('unknown');
  });
});
