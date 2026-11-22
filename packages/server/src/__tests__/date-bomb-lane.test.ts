import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import {
  DateBombSourceService, dateBombCheck, dateBombInputs, dateBombMode, dateBombsOf, recentServerTestFiles, runDetector, DATE_BOMB_MAX_PER_DAY,
  type DateBombDeps, type TimeTravelReport,
} from '../services/date-bomb-source';
import { oracleLaneSkipsPanel } from '../services/self-improvement-service';
import { testGapAutoApproveScope } from '../services/autonomy-shadow-service';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';
import { FITNESS_CONTRACTS } from '../services/fitness-contracts';
import { RUNBOOK_DEFAULTS, SCHEDULER_FLAGS } from '../services/config-defaults.generated';

const ROOT = path.resolve(__dirname, '../../../..');
const T = 'packages/server/src/__tests__';
const BOMB = `${T}/planted-bomb.test.ts`;
const STABLE = `${T}/planted-stable.test.ts`;
const FLAKY = `${T}/planted-flaky.test.ts`;
const BOMB_TEST = 'a fixed date read against the clock';

// The planted date bomb: its fixed date is its own file mtime (the OS clock), read against Date, so it passes at +0 d and
// fails once only Date is moved >= 3 d — whatever clock the outer suite runs on.
const BOMB_SRC = `import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const PLANTED = fs.statSync(fileURLToPath(import.meta.url)).mtimeMs;
it('${BOMB_TEST}', () => { expect(Date.now() - PLANTED).toBeLessThan(3 * 86_400_000); });
it('a neighbour that never depends on the date', () => { expect(1 + 1).toBe(2); });
`;
const FIXED_SRC = BOMB_SRC.replace('expect(Date.now() - PLANTED)', 'expect(PLANTED - PLANTED)'); // no longer reads the clock
const STABLE_SRC = "import { expect, it } from 'vitest';\nit('stable', () => { expect([1, 2].length).toBe(2); });\n";
// fails on its 2nd run only (the first +N run), passes on the confirmation re-run: the detector lists it as flaky
const FLAKY_SRC = `import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const COUNT = fileURLToPath(new URL('./flaky.count', import.meta.url));
it('fails once', () => { const n = (fs.existsSync(COUNT) ? Number(fs.readFileSync(COUNT, 'utf8')) : 0) + 1; fs.writeFileSync(COUNT, String(n)); expect(n).not.toBe(2); });
`;

let repo: string; let db: Database.Database;
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });

/** A minimal repository the real detector runs in: its script, the server harness and vitest (linked), three planted tests. */
function plantRepo(): void {
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  write('scripts/time-travel-tests.mjs', fs.readFileSync(path.join(ROOT, 'scripts/time-travel-tests.mjs'), 'utf8'));
  write(`${T}/helpers/time-travel.ts`, fs.readFileSync(path.join(ROOT, `${T}/helpers/time-travel.ts`), 'utf8'));
  write('packages/server/vitest.config.mts', "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['src/**/*.test.ts'], setupFiles: ['src/__tests__/helpers/time-travel.ts'] } });\n");
  write(BOMB, BOMB_SRC); write(STABLE, STABLE_SRC); write(FLAKY, FLAKY_SRC);
  write('.gitignore', 'node_modules\n.djimitflo\n*.count\n');
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'plant');
}

const report = (bombs: Array<[string, string, number]>, flaky: Array<[string, string, number]> = []): TimeTravelReport => ({
  baseline: { passed: 10, failed: 1 },
  horizons: [7, 30].map((days) => ({
    days,
    dateBombs: bombs.filter(([, , d]) => d <= days).map(([file, test]) => ({ file: file.replace('packages/server/', ''), test, status: 'failed', error: 'expected x' })),
    flaky: flaky.filter(([, , d]) => d === days).map(([file, test]) => ({ file: file.replace('packages/server/', ''), test, status: 'failed', error: null })),
  })),
});
/** deps whose worktree is the planted repository; detect is the real detector unless given */
const deps = (detect?: DateBombDeps['detect'], calls: string[] = []): DateBombDeps => ({
  mainSha: () => { calls.push('mainSha'); return 'sha-main'; },
  openWorktree: () => { calls.push('openWorktree'); return { path: repo, dispose: () => calls.push('dispose') }; },
  recentTestFiles: (wt) => { calls.push('recentTestFiles'); return recentServerTestFiles(wt); },
  detect: detect ?? ((wt, files) => runDetector(wt, files)),
});
const env = (mode?: string): NodeJS.ProcessEnv => ({ TEST_GAP_REPO_PATH: repo, ...(mode ? { DATE_BOMB_LANE: mode } : {}) });
const judgments = (name: string) => db.prepare('SELECT mode, decision, subject_id, answers_json AS a FROM judgments WHERE judgment = ? ORDER BY created_at, rowid').all(name) as Array<{ mode: string; decision: string; subject_id: string; a: string }>;
const proposals = () => db.prepare("SELECT id, status, title, description, evidence_refs_json AS refs, grounding_json AS g, panel_id FROM self_improvements WHERE evidence_refs_json LIKE '%\"date-bomb:%' ORDER BY created_at, rowid").all() as Array<{ id: string; status: string; title: string; description: string; refs: string; g: string; panel_id: string | null }>;
const goalOf = (improvementId: string): string => {
  db.prepare("UPDATE self_improvements SET status = 'scheduled' WHERE id = ?").run(improvementId);
  new AutonomousGoalGenerator(db).generateImprovement(improvementId);
  return (db.prepare('SELECT id FROM goals WHERE improvement_id = ?').get(improvementId) as { id: string }).id;
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'date-bomb-'));
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

describe('date-bomb lane (DATE_BOMB_LANE)', () => {
  it('off (the default): nothing is opened, run or recorded — the database is byte-identical', async () => {
    const calls: string[] = [];
    const dump = () => JSON.stringify((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
    const before = dump();
    expect(dateBombMode({})).toBe('off');
    expect(dateBombMode({ DATE_BOMB_LANE: 'yes' })).toBe('off');
    const lane = new DateBombSourceService(db, deps(async () => { calls.push('detect'); return { report: report([[BOMB, BOMB_TEST, 7]]) }; }, calls));
    expect(await lane.run(new Date(), env())).toEqual({ created: 0, skipped: 'disabled', bombs: null });
    expect(await lane.run(new Date(), env('off'))).toEqual({ created: 0, skipped: 'disabled', bombs: null });
    expect(calls).toEqual([]);
    expect(dump()).toBe(before);
    // and a run of any other lane gets no date-bomb check
    db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at) VALUES ('si-x', 'feature', 't', 'd', 'r', 'gap_analysis', 'executing', 0.6, '[\"test-gap:x\"]', datetime('now'), datetime('now'))").run();
    db.prepare("INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES ('g-x', 'si-x', 't', 'low', 'running')").run();
    expect(dateBombInputs(db, 'g-x')).toBeNull();
    expect(dateBombCheck(db, 'g-x', repo, repo, [`${T}/x.test.ts`])).toBeNull();
  });

  it('shadow: the real detector finds the planted bomb and ignores the stable and the flaky test; judgments only', async () => {
    plantRepo();
    const calls: string[] = [];
    const r = await new DateBombSourceService(db, deps(undefined, calls)).run(new Date(), env('shadow'));
    expect(r).toEqual({ created: 0, skipped: 'shadow', bombs: 1 });
    expect(calls).toEqual(['mainSha', 'openWorktree', 'recentTestFiles', 'dispose']);
    const [scan] = judgments('date_bomb_scan');
    expect(scan).toMatchObject({ mode: 'shadow', decision: 'recorded', subject_id: 'primary' });
    const a = JSON.parse(scan.a);
    expect([...a.files].sort()).toEqual([BOMB, FLAKY, STABLE]);
    expect(a.bombs).toEqual([{ file: BOMB, test: BOMB_TEST, days: 7 }]);
    expect(a.flaky).toEqual([`${FLAKY} > fails once`]);
    const candidates = judgments('date_bomb_candidate');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ mode: 'shadow', decision: 'recorded', subject_id: BOMB });
    expect(JSON.parse(candidates[0].a)).toMatchObject({ file: BOMB, test: BOMB_TEST, horizon_days: 7, status: 'failed', cause_class: null, proposal_id: null,
      acceptance: `node scripts/time-travel-tests.mjs --strict --days 7 ${BOMB}` });
    expect(db.prepare('SELECT COUNT(*) n FROM self_improvements').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM goals').get()).toEqual({ n: 0 });
    // weekly: a second tick within 7 d does not scan again
    const again = await new DateBombSourceService(db, deps(async () => { throw new Error('must not run'); })).run(new Date(), env('shadow'));
    expect(again.skipped).toMatch(/^scanned /);
  }, 120_000);

  it('a scan that cannot measure is insufficient, never 0 bombs', async () => {
    const r = await new DateBombSourceService(db, { ...deps(), recentTestFiles: () => [BOMB] }).run(new Date(), env('shadow'));
    expect(r).toEqual({ created: 0, skipped: 'detector missing: scripts/time-travel-tests.mjs', bombs: null });
    const [scan] = judgments('date_bomb_scan');
    expect(scan.decision).toBe('insufficient');
    expect(JSON.parse(scan.a)).toMatchObject({ bombs: null, baseline: null, error: 'detector missing: scripts/time-travel-tests.mjs' });
    expect(judgments('date_bomb_candidate')).toHaveLength(0);
  });

  it('dateBombsOf: confirmed bombs only, at the first horizon they fail, as repository paths', () => {
    expect(dateBombsOf(report([[BOMB, 'b7', 7], [BOMB, 'b30', 30]], [[FLAKY, 'f', 7]]))).toEqual([
      { file: BOMB, test: 'b7', days: 7, status: 'failed', error: 'expected x' },
      { file: BOMB, test: 'b30', days: 30, status: 'failed', error: 'expected x' },
    ]);
  });

  it('on: one grounded, test-only proposal per file with the detector at +0 and +N as its acceptance; panel and human approval stay; <= 2/day', async () => {
    const other = `${T}/other-bomb.test.ts`; const third = `${T}/third-bomb.test.ts`;
    const detect = async () => ({ report: report([[BOMB, BOMB_TEST, 7], [BOMB, 'later', 30], [other, 'o', 30], [third, 't', 7]]) });
    const lane = () => new DateBombSourceService(db, { ...deps(detect), recentTestFiles: () => [BOMB, other, third] });
    const r = await lane().run(new Date(), env('on'));
    expect(r).toEqual({ created: DATE_BOMB_MAX_PER_DAY, skipped: '', bombs: 4 });
    const [first, second] = proposals();
    expect(proposals()).toHaveLength(2);
    expect(first).toMatchObject({ status: 'proposed', title: `Fix the date bomb in ${BOMB} (red from +7 d)` });
    expect(first.panel_id).toBeTruthy();
    const command = `node scripts/time-travel-tests.mjs --strict --days 7 ${BOMB}`;
    expect(JSON.parse(first.g)).toMatchObject({ target: BOMB, artifactPath: BOMB, acceptanceTest: command, runtimeCommand: command });
    expect(first.description).toContain('Test-only fix');
    expect(first.description).toContain(`Edit only ${BOMB}. Do not touch product code`);
    const refs = JSON.parse(first.refs) as string[];
    expect(refs).toEqual([`date-bomb:primary/${BOMB}`, 'date-bomb-days:7', `date-bomb-test:${BOMB_TEST}`, 'date-bomb-test:later']);
    expect(JSON.parse(second.g).acceptanceTest).toBe(`node scripts/time-travel-tests.mjs --strict --days 7 ${third}`); // the sooner bomb first
    // one row per bomb; the +30 d file waits for the cap
    const rows = judgments('date_bomb_candidate');
    expect(rows.map((x) => [x.subject_id, x.mode, x.decision])).toEqual([[BOMB, 'act', 'proposed'], [BOMB, 'act', 'proposed'], [third, 'act', 'proposed'], [other, 'act', 'skipped']]);
    expect(JSON.parse(rows[0].a)).toMatchObject({ proposal_id: first.id });
    expect(JSON.parse(rows[3].a)).toMatchObject({ proposal_id: null });
    expect(db.prepare("SELECT reason FROM judgments WHERE judgment = 'date_bomb_candidate' AND subject_id = ?").get(other)).toEqual({ reason: 'daily cap reached' });
    expect((db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action = 'date_bomb_proposal'").get() as { n: number }).n).toBe(2);
    // not an auto-approved / panel-skipping oracle lane, even with every oracle-lane flag on
    expect(oracleLaneSkipsPanel({ source: 'gap_analysis', evidenceRefs: refs }, { ORACLE_LANES_SKIP_PANEL: 'true' })).toBe(false);
    const goal = goalOf(first.id);
    const flags = ['LOOP_AUTO_APPROVE_TEST_GAP', 'ORACLE_LANES_AUTO_APPROVE', 'LOOP_AUTO_APPROVE_MUTATION_GAP'];
    const saved = flags.map((f) => process.env[f]);
    try {
      for (const f of flags) process.env[f] = 'true';
      expect(testGapAutoApproveScope(db, goal)).toBeNull();
    } finally { flags.forEach((f, i) => { if (saved[i] === undefined) delete process.env[f]; else process.env[f] = saved[i]; }); }
    expect(dateBombInputs(db, goal)).toEqual({ file: BOMB, days: 7, tests: [BOMB_TEST, 'later'] });
    // the next week, the same files are not proposed again while their proposals are open
    db.prepare("DELETE FROM judgments WHERE judgment = 'date_bomb_scan'").run();
    const next = await lane().run(new Date(Date.now() + 2 * 86_400_000), env('on'));
    expect(next).toEqual({ created: 1, skipped: '', bombs: 4 });
    expect(proposals().map((p) => JSON.parse(p.g).artifactPath)).toEqual([BOMB, third, other]);
  });

  it('the maker gate: only the test file, then the detector at +0 and +N; a deleted test or product code fails', async () => {
    plantRepo();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'date-bomb-out-'));
    try {
      await new DateBombSourceService(db, deps(async () => ({ report: report([[BOMB, BOMB_TEST, 7]]) }))).run(new Date(), env('on'));
      const goal = goalOf(proposals()[0].id);
      // unfixed: red at +7
      expect(dateBombCheck(db, goal, repo, out, [BOMB])).toMatchObject({ name: 'test:date-bomb', status: 'fail', reason: 'fails_at_a_horizon', exit_status: 1 });
      // product code touched: fails on scope before anything runs
      expect(dateBombCheck(db, goal, repo, out, [BOMB, 'packages/server/src/services/clock.ts'])).toMatchObject({ status: 'fail', reason: expect.stringMatching(/^out_of_scope: packages\/server\/src\/services\/clock\.ts/) });
      // the bombed test deleted: the file is green at both horizons, but the test is gone
      write(BOMB, BOMB_SRC.replace(/it\('a fixed[^\n]*\n/, ''));
      expect(dateBombCheck(db, goal, repo, out, [BOMB])).toMatchObject({ status: 'fail', reason: 'bombed_test_missing', exit_status: 0 });
      // fixed: green at +0 and +7, the test still there
      write(BOMB, FIXED_SRC);
      expect(dateBombCheck(db, goal, repo, out, [BOMB])).toMatchObject({ status: 'pass', exit_status: 0 });
      // the detector missing from the worktree fails, never skips
      fs.rmSync(path.join(repo, 'scripts'), { recursive: true });
      expect(dateBombCheck(db, goal, repo, out, [BOMB])).toMatchObject({ status: 'fail', reason: 'missing_detector' });
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  }, 120_000);

  it('registers its flag: acting, documented default off, a scheduler, a fitness contract', () => {
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'DATE_BOMB_LANE', acting: true });
    expect(RUNBOOK_DEFAULTS.DATE_BOMB_LANE).toMatch(/^off/);
    expect(SCHEDULER_FLAGS).toContain('DATE_BOMB_LANE');
    const c = FITNESS_CONTRACTS.find((x) => x.flags.includes('DATE_BOMB_LANE'));
    expect(c).toMatchObject({ component: 'lane_date_bomb', class: 'lane' });
    expect(c!.outcome.metric).toMatch(/\+0 d and at \+N d.*14 d/);
  });
});
