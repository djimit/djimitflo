import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteGymService } from '../services/remote-gym-service';
import { NATIVE_TOOLS_CAPABILITY, gymNativeToolsEvidence, nativeToolsForClaim, sanitizeNativeTools } from '../services/gym-native-tools';
import { EVOLUTION_FLAGS, buildEvolutionEvidence } from '../services/evolution-evidence';

// GYM_NATIVE_SKILL_TOOLS: the oracle-gate skill as a native atomic tool (MCP) on ordinary remote gym attempts only.
const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
const CAPS = ['canary', 'write_test', 'prod_gates', 'prompt_override', 'procedure_lines'];
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo');
});
afterEach(() => { vi.unstubAllEnvs(); db.close(); });
const meta = (runId: string) => JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(runId) as { metadata: string }).metadata);
const ok = { status: 'success' as const, reason: 'tests green, source only', changed_files: ['packages/server/src/services/x.ts'], diff: '+x', tokens: null, durationMs: 1000 };

it('off (default): a claim never carries native_skill_tools, even to a worker announcing the capability', () => {
  const svc = new RemoteGymService(db, () => [TASK('c1')]);
  const claim = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: [...CAPS, NATIVE_TOOLS_CAPABILITY] }) as Record<string, unknown>;
  expect(claim.task).toMatchObject({ commit: 'c1' });
  expect('native_skill_tools' in claim).toBe(false);
  expect('native_skill_tools' in meta(String(claim.runId)).gym).toBe(false);
});

it('on: only a worker announcing native_skill_tools is offered oracle_gate; the run records what was offered', () => {
  vi.stubEnv('GYM_NATIVE_SKILL_TOOLS', 'on');
  const svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2')]);
  const plain = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: CAPS }) as Record<string, unknown>;
  expect('native_skill_tools' in plain).toBe(false);
  const withTools = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: [...CAPS, NATIVE_TOOLS_CAPABILITY] }) as Record<string, unknown>;
  expect(withTools.native_skill_tools).toEqual(['oracle_gate']);
  expect(meta(String(withTools.runId)).gym.native_skill_tools).toEqual(['oracle_gate']);
});

it('never on an experiment, trial, canary or probe attempt (not ordinary) nor on a holdout task', () => {
  const on = { GYM_NATIVE_SKILL_TOOLS: 'on' };
  expect(nativeToolsForClaim([NATIVE_TOOLS_CAPABILITY], true, () => false, on)).toEqual(['oracle_gate']);
  expect(nativeToolsForClaim([NATIVE_TOOLS_CAPABILITY], false, () => false, on)).toBeNull();
  expect(nativeToolsForClaim([NATIVE_TOOLS_CAPABILITY], true, () => true, on)).toBeNull();
  expect(nativeToolsForClaim([NATIVE_TOOLS_CAPABILITY], true, () => { throw new Error('not consulted when off'); }, {})).toBeNull();
});

it('only on/off: any other value is off', () => {
  vi.stubEnv('GYM_NATIVE_SKILL_TOOLS', 'true');
  const svc = new RemoteGymService(db, () => [TASK('c1')]);
  const claim = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: [NATIVE_TOOLS_CAPABILITY] }) as Record<string, unknown>;
  expect('native_skill_tools' in claim).toBe(false);
});

it('record stores the tool-call counts of an offered run, sanitised; unreported = null (unknown), never 0', () => {
  vi.stubEnv('GYM_NATIVE_SKILL_TOOLS', 'on');
  const svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2'), TASK('c3')]);
  const a = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: [NATIVE_TOOLS_CAPABILITY] }) as { runId: string };
  svc.record(a.runId, 'workstation', { ...ok, native_tools: { offered: ['oracle_gate', 'rm_rf'], calls: 2, steps_after_pass: 1, mutants: ['m1'],
    results: [{ pass: false, digest_ok: true, checks: [{ name: 'x', mutants: ['m1'] }] }, { pass: true, digest_ok: true }] } } as never);
  expect(meta(a.runId).gym_result.native_tools).toEqual({ offered: ['oracle_gate'], calls: 2, results: [{ pass: false, digest_ok: true }, { pass: true, digest_ok: true }], steps_after_pass: 1 });
  const b = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: [NATIVE_TOOLS_CAPABILITY] }) as { runId: string };
  svc.record(b.runId, 'workstation', ok);
  expect(meta(b.runId).gym_result.native_tools).toBeNull();
  // a run that was not offered the tool never stores what a worker claims about it
  vi.stubEnv('GYM_NATIVE_SKILL_TOOLS', 'off');
  const c = svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: [NATIVE_TOOLS_CAPABILITY] }) as { runId: string };
  svc.record(c.runId, 'workstation', { ...ok, native_tools: { offered: ['oracle_gate'], calls: 1, results: [{ pass: true, digest_ok: true }], steps_after_pass: 0 } } as never);
  expect('native_tools' in meta(c.runId).gym_result).toBe(false);
});

it('sanitizeNativeTools: unknown calls stay null, not 0; no mutant or check detail survives (NE-013)', () => {
  expect(sanitizeNativeTools({ offered: ['oracle_gate'], calls: null, results: [], steps_after_pass: null }, ['oracle_gate'])).toEqual({ offered: ['oracle_gate'], calls: null, results: [], steps_after_pass: null });
  expect(sanitizeNativeTools('nope', ['oracle_gate'])).toBeNull();
  expect(sanitizeNativeTools({ offered: ['oracle_gate'], calls: -1, results: [{ pass: 'yes' }], steps_after_pass: 1.5 }, ['oracle_gate']))
    .toEqual({ offered: ['oracle_gate'], calls: null, results: [{ pass: null, digest_ok: null }], steps_after_pass: null });
  const many = sanitizeNativeTools({ offered: ['oracle_gate'], calls: 30, results: Array.from({ length: 30 }, () => ({ pass: false })), steps_after_pass: null }, ['oracle_gate']);
  expect(many?.results).toHaveLength(20);
  expect(JSON.stringify(sanitizeNativeTools({ offered: ['oracle_gate'], calls: 1, results: [{ pass: true, digest_ok: true, mutants: ['a'], score: { gain: 1 } }], steps_after_pass: 0 }, ['oracle_gate']))).not.toMatch(/mutant|score/);
});

it('evidence: offered, called, pass rate when called and attempts that stopped within N steps after a pass (descriptive)', () => {
  vi.stubEnv('GYM_NATIVE_SKILL_TOOLS', 'on');
  const svc = new RemoteGymService(db, () => ['c1', 'c2', 'c3', 'c4', 'c5'].map(TASK));
  const claim = () => (svc.claim('workstation', ['atomic@llama-router'], new Date(), { capabilities: [NATIVE_TOOLS_CAPABILITY] }) as { runId: string }).runId;
  const nt = (calls: number | null, passes: Array<boolean | null>, steps: number | null) => ({ offered: ['oracle_gate'], calls, results: passes.map((pass) => ({ pass, digest_ok: true })), steps_after_pass: steps });
  svc.record(claim(), 'workstation', { ...ok, native_tools: nt(2, [false, true], 1) } as never); // passed, then replied
  svc.record(claim(), 'workstation', { ...ok, status: 'failure', reason: 'tests still red', native_tools: nt(1, [true], 9) } as never); // passed, kept editing
  svc.record(claim(), 'workstation', { ...ok, status: 'failure', reason: 'tests still red', native_tools: nt(0, [], null) } as never); // never called
  svc.record(claim(), 'workstation', { ...ok, native_tools: nt(null, [], null) } as never); // trace unreadable: unknown
  svc.record(claim(), 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' }); // never ran
  const ev = gymNativeToolsEvidence(db, new Date(Date.now() - 86_400_000).toISOString(), process.env);
  expect(ev).toEqual({ mode: 'on', stop_within_steps: 2, offered: 5, scored: 4, reported: 3, unknown: 1, called: 2, calls: 3, calls_passed: 2,
    call_pass_rate: 0.667, attempts_passed: 2, attempt_pass_rate: 1, stopped_within_n: 1 });
  const full = buildEvolutionEvidence(db, process.env);
  expect(full.gym_native_tools).toEqual(ev);
  expect(EVOLUTION_FLAGS).toContainEqual({ name: 'GYM_NATIVE_SKILL_TOOLS', acting: true });
});

it('evidence before any offered run: counts are 0 attempts and every rate is null (insufficient), never 0', () => {
  expect(gymNativeToolsEvidence(db, new Date(0).toISOString(), {})).toEqual({ mode: null, stop_within_steps: 2, offered: 0, scored: 0, reported: 0, unknown: 0, called: 0, calls: 0,
    calls_passed: 0, call_pass_rate: null, attempts_passed: 0, attempt_pass_rate: null, stopped_within_n: 0 });
  db.exec('DROP TABLE loop_runs');
  expect(gymNativeToolsEvidence(db, new Date(0).toISOString(), {})).toBeNull();
});
