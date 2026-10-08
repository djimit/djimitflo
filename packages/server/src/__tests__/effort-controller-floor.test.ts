import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import {
  EFFORT_DECISION_POINTS, EFFORT_FLOOR, JUDGMENT_CONSUMERS, recordEffortGym, recordEffortJudgment, recordEffortSibling,
} from '../services/effort-controller';
import { LoopDaemon } from '../services/loop-daemon';
import { GoalService } from '../services/goal-service';
import type { LoopService } from '../services/loop-service';
import type { Species } from '../services/evolve-selection';

/**
 * S7 (operator 09-10): the EVC effort controller may only ever weigh effort (siblings, gym serves, judgment runs) — never
 * the floor: deterministic gates, the checker / security_checker reviewers, the scope gate, the human merge or auth. This
 * locks in today's decision points and options; adding one fails here until EFFORT_DECISION_POINTS (and, if it touches the
 * floor, an operator decision) says so. In shadow mode the hooks change nothing.
 */
const SRC = join(__dirname, '..');
const CONTROLLER = readFileSync(join(SRC, 'services/effort-controller.ts'), 'utf8');
const SPECIES = '<species>';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); new SkillEvolutionEngine(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const lcg = (seed: number) => { let s = seed; return () => { s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296; return s / 4_294_967_296; }; };
const SHADOW_EXPLORE = { EFFORT_CONTROLLER_MODE: 'shadow', EFFORT_EXPLORATION: '1' };
const decisions = () => [
  ...(db.prepare("SELECT metadata FROM loop_events WHERE event_type = 'effort_decision'").all() as Array<{ metadata: string }>).map((r) => JSON.parse(r.metadata)),
  ...(db.prepare("SELECT answers_json AS metadata FROM judgments WHERE judgment = 'effort_decision'").all() as Array<{ metadata: string }>).map((r) => JSON.parse(r.metadata)),
] as Array<{ decision_point: string; default_option: string; chosen_option: string; evc: Record<string, number> }>;

it('the controller has exactly the declared decision points (source scan of every decide() call)', () => {
  const callSites = CONTROLLER.match(/\bdecide\(/g)!.length - 1; // minus the definition
  const points = [...CONTROLLER.matchAll(/\bdecide\(db, env, rng, now, (['`])([^'`]+)\1/g)].map((m) => m[2].replace('${judgment}', '<id>'));
  expect(points).toHaveLength(callSites); // every call site names its point literally
  expect(points.sort()).toEqual(Object.keys(EFFORT_DECISION_POINTS).sort());
});

it('no decision point and no option is a floor control (gates, reviewers, scope gate, human merge, auth)', () => {
  expect([...EFFORT_FLOOR].sort()).toEqual(['auth', 'checker', 'deterministic_gates', 'human_merge', 'scope_gate', 'security_checker']);
  const floor = new Set<string>(EFFORT_FLOOR);
  const pointNames = [...Object.keys(EFFORT_DECISION_POINTS), ...Object.keys(JUDGMENT_CONSUMERS).map((j) => `judgment:${j}`)];
  for (const p of pointNames) expect(floor.has(p.replace(/^judgment:/, '')), p).toBe(false);
  for (const opts of Object.values(EFFORT_DECISION_POINTS)) for (const o of opts) expect(floor.has(o), o).toBe(false);
  // every decision point can always pick today's behaviour (its default is one of its options)
  expect(EFFORT_DECISION_POINTS.remote_gym_claim).toContain('serve');
  expect(EFFORT_DECISION_POINTS['judgment:<id>']).toContain('run');
});

it('every option the hooks actually record (forced exploration, many draws) is a declared one', () => {
  const remote: Species = { runtime: 'remote', model: 'llama-router/atomic' };
  const cloud: Species = { runtime: 'opencode', model: 'ollama/kimi-k2.6:cloud' };
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('r1', 'test-gap', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', datetime('now'), datetime('now'))`).run();
  for (let seed = 1; seed <= 25; seed++) {
    recordEffortSibling(db, 'r1', 'test-gap', [remote, cloud], [remote, cloud], SHADOW_EXPLORE, lcg(seed));
    recordEffortSibling(db, 'r1', 'test-gap', [cloud], [], SHADOW_EXPLORE, lcg(seed));
    recordEffortGym(db, 'r1', 'atomic@llama-router', 'c1', SHADOW_EXPLORE, lcg(seed));
    for (const j of Object.keys(JUDGMENT_CONSUMERS)) recordEffortJudgment(db, j, { type: 'agent_message', id: `m${seed}` }, SHADOW_EXPLORE, lcg(seed));
  }
  const seen = decisions();
  expect(seen.length).toBe(25 * (3 + Object.keys(JUDGMENT_CONSUMERS).length));
  const speciesKeys = new Set(['remote@llama-router/atomic', 'opencode@ollama/kimi-k2.6:cloud']);
  for (const d of seen) {
    const key = d.decision_point.startsWith('judgment:') ? 'judgment:<id>' : d.decision_point;
    const allowed = (EFFORT_DECISION_POINTS as Record<string, readonly string[]>)[key];
    expect(allowed, d.decision_point).toBeDefined();
    for (const o of [...Object.keys(d.evc), d.chosen_option, d.default_option]) {
      expect(allowed.includes(speciesKeys.has(o) ? SPECIES : o), `${d.decision_point}: ${o}`).toBe(true);
    }
  }
  expect(new Set(seen.map((d) => d.chosen_option)).size).toBeGreaterThan(3); // exploration really drew non-default options
});

it('the hooks return nothing and nothing outside the controller reads a decision; only the known callers import it', () => {
  expectTypeOf(recordEffortSibling).returns.toEqualTypeOf<void>();
  expectTypeOf(recordEffortGym).returns.toEqualTypeOf<void>();
  expectTypeOf(recordEffortJudgment).returns.toEqualTypeOf<void>();
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'node_modules') walk(p); } else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) files.push(p); } };
  walk(SRC);
  const importers: Record<string, string[]> = {}; const readers: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8'); const rel = relative(SRC, f);
    if (rel === 'services/effort-controller.ts') continue;
    const m = /import \{([^}]*)\} from '\.{1,2}\/(?:services\/)?effort-controller'/.exec(text);
    if (m) importers[rel] = m[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
    if (text.includes('effort_decision')) readers.push(rel);
  }
  expect(importers).toEqual({
    'services/evolution-evidence.ts': ['effortX1Evidence'],
    'services/judgment-service.ts': ['recordEffortJudgment'],
    'services/loop-daemon.ts': ['assignSiblingArm', 'recordEffortSibling', 'siblingRandomiseEnabled'],
    'services/remote-gym-service.ts': ['recordEffortGym'],
  });
  expect(readers).toEqual([]);
});

/** The loop daemon with automated checker + security checker: the reviewer dispatch is identical with the controller off and in shadow. */
const stub = () => ({
  startDocDriftAndSmallFixLoop: vi.fn(() => ({ id: 'run-1', findings: [{ id: 'f1', type: 'test_finding', severity: 'info', file: 'x', message: 'x', evidence: 'x', suggested_fix: 'x' }] })),
  continueLoopRun: vi.fn(() => ({ leases: [{ id: 'maker-1', role: 'maker', status: 'prepared', runtime: 'codex' }, { id: 'checker-1', role: 'checker', status: 'prepared', runtime: 'manual' }] })),
  executeWorker: vi.fn(async () => ({})),
  runDeterministicChecks: vi.fn(() => ({ run: { status: 'completed' }, lease: {}, checks: [] })),
  retryLoopRun: vi.fn(() => ({ retry_maker: { id: 'maker-2', role: 'maker', status: 'prepared', runtime: 'opencode' }, retry_checker: { id: 'checker-2', role: 'checker', status: 'prepared', runtime: 'manual' } })),
  executeChecker: vi.fn(async () => ({})),
  verifyLoopRun: vi.fn(() => ({ gates: [] })),
  pruneOrphanedWorktrees: vi.fn(),
});

async function daemonPass(mode: 'off' | 'shadow') {
  db.exec("DELETE FROM loop_events; DELETE FROM worker_leases; DELETE FROM loop_runs; UPDATE goals SET status = 'cancelled'");
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('run-1', 'doc-drift-and-small-fix-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', datetime('now'), datetime('now'))`).run();
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, metadata, created_at, updated_at)
    VALUES ('sec-1', 'run-1', 'security_checker', 'manual', 'prepared', 'f1', '{}', datetime('now'), datetime('now'))`).run();
  const goal = new GoalService(db).createGoal({ objective: 'Add a test', acceptance_criteria: ['Tests pass'], risk_class: 'low', metadata: { evolve: true } });
  db.prepare("UPDATE goals SET status = 'decomposed' WHERE id = ?").run(goal.id);
  vi.stubEnv('EFFORT_CONTROLLER_MODE', mode); vi.stubEnv('EFFORT_EXPLORATION', '1');
  const loops = stub();
  const daemon = new LoopDaemon(db, loops as unknown as LoopService, { pollMs: 3_600_000, maxConcurrentGoals: 4 });
  await daemon.tick(); await new Promise((r) => setImmediate(r)); daemon.stop();
  return loops;
}

it('EFFORT_CONTROLLER_MODE=shadow (even exploring every time) leaves maker, check, reviewer and verify dispatch unchanged', async () => {
  vi.stubEnv('LOOP_EVOLVE_ENABLED', 'true'); vi.stubEnv('LOOP_EVOLVE_SPECIES', 'opencode@ollama/kimi-k2.6:cloud');
  vi.stubEnv('LOOP_DAEMON_AUTOMATED_CHECKER_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_AUTOMATED_SECURITY_CHECKER_ENABLED', 'true');
  const off = await daemonPass('off');
  expect(decisions()).toEqual([]);
  const roles = (l: ReturnType<typeof stub>) => l.executeChecker.mock.calls.map((c) => (c as unknown[])[1]);
  expect(roles(off).length).toBeGreaterThanOrEqual(2); // checker and security_checker were dispatched
  const shadow = await daemonPass('shadow');
  expect(decisions().map((d) => d.decision_point)).toEqual(['evolve_sibling']);
  expect(roles(shadow)).toEqual(roles(off));
  for (const fn of ['executeWorker', 'runDeterministicChecks', 'retryLoopRun', 'verifyLoopRun'] as const) {
    expect(shadow[fn].mock.calls, fn).toEqual(off[fn].mock.calls);
  }
});
