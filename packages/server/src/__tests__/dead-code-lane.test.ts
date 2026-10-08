import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { UsageTelemetry } from '../services/usage-telemetry';
import { DeadCodeSourceService, deadCodeCheckEnv, discoverDeadCode } from '../services/dead-code-source-service';
import { oracleLaneSkipsPanel } from '../services/self-improvement-service';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { testGapAutoApproveScope } from '../services/autonomy-shadow-service';

const NOW = new Date('2026-10-20T12:00:00Z');
const S = 'packages/server/src';
let repo: string; let db: Database.Database;
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const usage = (day: string, name: string, count: number) => db.prepare("INSERT INTO usage_counts (day, kind, name, method, status_class, count) VALUES (?, 'api', ?, 'GET', '2xx', ?)").run(day, name, count);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-code-'));
  write(`${S}/index.ts`, "import { live } from './services/live';\nimport { createRoutes } from './routes';\nlive(); createRoutes();\n");
  write(`${S}/services/live.ts`, "import { loader } from './loader';\nexport const live = () => loader();\n");
  write(`${S}/services/loader.ts`, "export const loader = () => import(`./plugins/${'named'}`);\nconst KNOWN = ['named'];\nexport default KNOWN;\n");
  write(`${S}/services/orphan.ts`, "export function orphan() {\n  return 42;\n}\n");
  write(`${S}/services/named.ts`, 'export const named = 1;\n');
  write(`${S}/__tests__/orphan.test.ts`, "import { orphan } from '../services/orphan';\nimport { it } from 'vitest';\nit('x', () => orphan());\n");
  write(`${S}/routes/index.ts`, [
    "import { createHotRoutes } from './hot';", "import { createColdRoutes } from './cold';", "import { createCalledRoutes } from './called';",
    'export function createRoutes() {', '  const mounts = [',
    "    { prefix: '/hot', middleware: [requireAuth], router: createHotRoutes(db, auth) },",
    "    { prefix: '/cold', middleware: [requireAuth], router: createColdRoutes(db, auth) },",
    "    { prefix: '/called', middleware: [requireAuth], router: createCalledRoutes(db, auth) },",
    '  ];', '}', '',
  ].join('\n'));
  for (const name of ['hot', 'called']) write(`${S}/routes/${name}.ts`, `export function create${name[0].toUpperCase()}${name.slice(1)}Routes() { router.get('/x', h); }\n`);
  write(`${S}/routes/cold.ts`, "import { coldService } from '../services/cold-service';\nimport { live } from '../services/live';\nexport function createColdRoutes() { router.get('/a', h); router.post('/b', h); coldService(); live(); }\n");
  write(`${S}/services/cold-service.ts`, 'export const coldService = () => 1;\n');
  write('packages/dashboard/src/api.ts', "export const list = () => fetch('/api/called/x');\n");
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  new UsageTelemetry(db, 0);
  usage('2026-09-28', '/api/hot/x', 5);
});
afterEach(() => { db.close(); fs.rmSync(repo, { recursive: true, force: true }); delete process.env.DEAD_CODE_LANE_ENABLED; delete process.env.DEAD_CODE_MAX_PER_DAY; delete process.env.TEST_GAP_REPO_PATH; });

describe('dead-code candidates', () => {
  it('finds an unimported file with its test, skips a file named by string, a hit route and a called route', () => {
    const { units, skipped } = discoverDeadCode(repo, db, NOW);
    expect(units.map((u) => u.id).sort()).toEqual([`${S}/services/orphan.ts`, 'routes:cold']);
    const orphan = units.find((u) => u.kind === 'file')!;
    expect(orphan.remove).toEqual([`${S}/services/orphan.ts`]);
    expect(orphan.allow).toEqual([`${S}/__tests__/orphan.test.ts`]);
    expect(orphan.evidence.join('\n')).toContain('no production importer');
    expect(skipped).toContainEqual({ id: `${S}/services/named.ts`, reason: expect.stringContaining(`${S}/services/loader.ts`) });
    expect(skipped).toContainEqual({ id: 'routes:hot', reason: expect.stringContaining('5 hit(s)') });
    expect(skipped).toContainEqual({ id: 'routes:called', reason: expect.stringContaining('packages/dashboard/src/api.ts') });
    // the route group takes the service only it uses, never one live code still imports
    const cold = units.find((u) => u.id === 'routes:cold')!;
    expect(cold.remove).toEqual([`${S}/routes/cold.ts`, `${S}/services/cold-service.ts`]);
    expect(cold.allow).toEqual([`${S}/routes/index.ts`]);
    expect(cold.evidence.join('\n')).toMatch(/0 api hits on \/api\/cold .*since 2026-09-28 \(22 days\), 2 endpoint/);
    expect(cold.evidence.join('\n')).toContain('0 callers of /cold');
  });

  it('proposes no route group before 14 days of telemetry', () => {
    const { units, skipped } = discoverDeadCode(repo, db, new Date('2026-10-07T12:00:00Z'));
    expect(units.map((u) => u.id)).toEqual([`${S}/services/orphan.ts`]);
    expect(skipped).toContainEqual({ id: 'route-groups', reason: 'usage telemetry covers 9 day(s) < 14' });
  });

  it('skips a route group whose API path the server itself names (a self-call the import graph cannot see)', () => {
    write(`${S}/services/live.ts`, "import { loader } from './loader';\nexport const live = () => loader() && fetch('http://127.0.0.1/api/cold/a');\n");
    const { units, skipped } = discoverDeadCode(repo, db, NOW);
    expect(units.map((u) => u.id)).not.toContain('routes:cold');
    expect(skipped).toContainEqual({ id: 'routes:cold', reason: `path named in ${S}/services/live.ts` });
  });

  it('skips a file whose test also covers live code', () => {
    write(`${S}/__tests__/mixed.test.ts`, "import { orphan } from '../services/orphan';\nimport { live } from '../services/live';\n");
    const { units, skipped } = discoverDeadCode(repo, db, NOW);
    expect(units.map((u) => u.id)).not.toContain(`${S}/services/orphan.ts`);
    expect(skipped).toContainEqual({ id: `${S}/services/orphan.ts`, reason: expect.stringContaining('also tests live code') });
  });
});

describe('dead-code lane intake', () => {
  it('is off by default, capped per day, normal risk: keeps the panel and is never auto-approved', () => {
    const now = new Date(); // the cap counts created_at, which is wall-clock time
    usage(new Date(now.getTime() - 20 * 86_400_000).toISOString().slice(0, 10), '/api/hot/x', 1);
    const lane = new DeadCodeSourceService(db);
    expect(lane.run(now)).toEqual({ created: 0, skipped: 'disabled' });
    process.env.DEAD_CODE_LANE_ENABLED = 'true'; process.env.TEST_GAP_REPO_PATH = repo; process.env.DEAD_CODE_MAX_PER_DAY = '1';
    expect(lane.run(now).created).toBe(1);
    expect(lane.run(now)).toEqual({ created: 0, skipped: 'daily cap reached' });
    const rows = db.prepare("SELECT id, type, status, evidence_refs_json AS refs, grounding_json AS g FROM self_improvements WHERE evidence_refs_json LIKE '%dead-code:%'").all() as Array<{ id: string; type: string; status: string; refs: string; g: string }>;
    expect(rows).toHaveLength(1);
    const refs = JSON.parse(rows[0].refs) as string[];
    expect(refs).toContain('dead-code:routes:cold'); // smallest unit first (6 lines)
    expect(refs.some((r) => r.startsWith('dead-code-evidence:usage_counts 0 api hits'))).toBe(true);
    expect(rows[0].type).toBe('refactor');
    expect(rows[0].status).toBe('proposed');
    expect(JSON.parse(rows[0].g).runtimeCommand).toContain('npm run test:dead-code:grounded');
    expect(oracleLaneSkipsPanel({ source: 'gap_analysis', evidenceRefs: refs }, { ORACLE_LANES_SKIP_PANEL: 'true' })).toBe(false);

    db.prepare("UPDATE self_improvements SET status = 'scheduled' WHERE id = ?").run(rows[0].id);
    new AutonomousGoalGenerator(db).generateImprovement(rows[0].id);
    const goal = db.prepare('SELECT id, risk_class FROM goals WHERE improvement_id = ?').get(rows[0].id) as { id: string; risk_class: string };
    expect(goal.risk_class).toBe('low');
    expect(deadCodeCheckEnv(db, goal.id)).toEqual({ DEAD_CODE_REMOVE: `${S}/routes/cold.ts,${S}/services/cold-service.ts`, DEAD_CODE_ALLOW: `${S}/routes/index.ts` });
    process.env.LOOP_AUTO_APPROVE_TEST_GAP = 'true';
    try { expect(testGapAutoApproveScope(db, goal.id)).toBeNull(); } finally { delete process.env.LOOP_AUTO_APPROVE_TEST_GAP; }

    // the next day the second unit comes; a unit is never proposed twice
    expect(lane.run(new Date(now.getTime() + 2 * 86_400_000))).toEqual({ created: 0, skipped: 'enough proposals in flight' });
  });
});

describe('dead-code gate (scripts/dead-code-gate.mjs)', () => {
  const gate = async () => (await import('../../../../scripts/dead-code-gate.mjs')) as {
    deletionGate: (i: { changes: Array<{ path: string; added: number; removed: number }>; remove: string[]; allow?: string[]; exists?: (p: string) => boolean }) => { pass: boolean; reasons: string[] };
    touchedPackages: (p: string[]) => string[];
  };
  const gone = () => false;

  it('passes a deletion-dominant change of the named files only', async () => {
    const { deletionGate, touchedPackages } = await gate();
    const changes = [{ path: 'packages/server/src/routes/cold.ts', added: 0, removed: 80 }, { path: 'packages/server/src/routes/index.ts', added: 0, removed: 2 }, { path: 'package-lock.json', added: 40, removed: 0 }];
    expect(deletionGate({ changes, remove: ['packages/server/src/routes/cold.ts'], allow: ['packages/server/src/routes/index.ts'], exists: gone })).toMatchObject({ pass: true });
    expect(touchedPackages(changes.map((c) => c.path))).toEqual(['server']);
  });

  it('fails when adds exceed 10 % of removed lines, a file outside the scope changes, or a named file stays', async () => {
    const { deletionGate } = await gate();
    const remove = ['a.ts'];
    expect(deletionGate({ changes: [{ path: 'a.ts', added: 11, removed: 100 }], remove, exists: gone }).reasons.join()).toContain('not deletion-dominant: 11');
    expect(deletionGate({ changes: [{ path: 'a.ts', added: 10, removed: 100 }], remove, exists: gone }).pass).toBe(true);
    expect(deletionGate({ changes: [{ path: 'a.ts', added: 0, removed: 100 }, { path: 'b.ts', added: 0, removed: 1 }], remove, exists: gone }).reasons.join()).toContain('outside the named files: b.ts');
    expect(deletionGate({ changes: [{ path: 'a.ts', added: 0, removed: 3 }], remove, exists: () => true }).reasons.join()).toContain('still present: a.ts');
    expect(deletionGate({ changes: [], remove, exists: gone }).reasons).toContain('nothing removed');
  });

  it('runs against a real git working tree and is a no-op without DEAD_CODE_REMOVE', () => {
    const script = path.resolve(__dirname, '../../../../scripts/dead-code-gate.mjs');
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    const run = (env: Record<string, string>) => spawnSync('node', [script], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });
    expect(run({}).stdout).toContain('skipped');
    write('dead.js', 'x\n'.repeat(40)); git('add', 'dead.js'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'dead');
    fs.rmSync(path.join(repo, 'dead.js'));
    expect(run({ DEAD_CODE_REMOVE: 'dead.js' }).status).toBe(0);
    write('extra.js', 'y\n'.repeat(10)); // 11 added lines > 10 % of 40 removed
    const r = run({ DEAD_CODE_REMOVE: 'dead.js', DEAD_CODE_ALLOW: 'extra.js' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('not deletion-dominant');
  });
});
