import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { captureReadSet, readSetPaths, staleAgainst } from '../services/evidence-freshness';
import { LoopDraftPrService } from '../services/loop-draft-pr-service';

let db: Database.Database; let wt: string; let remote: string; let other: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const commit = (cwd: string, msg: string) => { git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg); };
const write = (cwd: string, rel: string, s: string) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), s); };
const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/pull/9' }) });
const env = (mode?: string) => ({ LOOP_AUTO_DRAFT_PR_ENABLED: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't0ken', ...(mode ? { LOOP_EVIDENCE_FRESHNESS_MODE: mode } : {}) });

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  remote = path.join(root, 'remote.git'); wt = path.join(root, 'wt'); other = path.join(root, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', wt]);
  write(wt, 'package.json', '{"name":"r"}\n'); write(wt, 'package-lock.json', '{}\n'); write(wt, 'tsconfig.json', '{}\n');
  write(wt, 'packages/server/vitest.config.ts', 'export default {};\n');
  write(wt, 'packages/server/src/services/dep.ts', 'export const dep = 1;\n');
  write(wt, 'packages/server/src/services/target.ts', "import { dep } from './dep';\nexport const t = dep;\n");
  commit(wt, 'base'); git(wt, 'remote', 'add', 'origin', remote); git(wt, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, other]);
  // the maker's change: a new test that imports target (which imports dep)
  write(wt, 'packages/server/src/__tests__/target.test.ts', "import { t } from '../services/target';\nit('t', () => { expect(t).toBe(1); });\n");

  db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = ON');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('run-1', 'test-gap', 'closed', 'ready_for_human_merge', '[]', ?, ?)`).run(now, now);
  const rs = captureReadSet(wt, ['packages/server/src/__tests__/target.test.ts']);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, branch_name, metadata, created_at, updated_at) VALUES ('m1', 'run-1', 'maker', 'opencode', 'completed', ?, 'agent/loop/run-1', ?, ?, ?)`)
    .run(wt, JSON.stringify({ evidence_read_set: rs }), now, now);
});
afterEach(() => { db.close(); });

it('B8-FRESH: the read set holds configs, the lockfile and the imports of the changed files — never the changed files', () => {
  const files: Record<string, string> = { 'a.ts': "import x from './b';\nimport y from '../c';\n", 'b.ts': '', 'package-lock.json': '{}' };
  const read = (rel: string) => (rel in files ? files[rel] : null);
  expect(readSetPaths(['a.ts'], read, () => ['package-lock.json', 'README.md', 'tsconfig.json'])).toEqual(['b.ts', 'package-lock.json', 'tsconfig.json']);
  const rs = captureReadSet(wt, ['packages/server/src/__tests__/target.test.ts']);
  expect(Object.keys(rs.files)).toEqual(['package-lock.json', 'package.json', 'packages/server/src/services/target.ts', 'packages/server/vitest.config.ts', 'tsconfig.json']);
  expect(rs.base).toBe(git(wt, 'rev-parse', 'HEAD'));
});

it('B8-FRESH: unchanged main is fresh; a changed lockfile, config or imported module on main makes it stale', () => {
  const rs = captureReadSet(wt, ['packages/server/src/__tests__/target.test.ts']);
  git(wt, 'fetch', '-q', 'origin', 'main');
  expect(staleAgainst(wt, rs, 'FETCH_HEAD')).toEqual([]);
  write(other, 'package-lock.json', '{"v":2}\n'); write(other, 'packages/server/src/services/target.ts', 'export const t = 2;\n'); commit(other, 'main moved'); git(other, 'push', '-q', 'origin', 'main');
  git(wt, 'fetch', '-q', 'origin', 'main');
  expect(staleAgainst(wt, rs, 'FETCH_HEAD')).toEqual(['package-lock.json', 'packages/server/src/services/target.ts']);
});

const mainMoves = () => { write(other, 'tsconfig.json', '{"strict":true}\n'); commit(other, 'config moved'); git(other, 'push', '-q', 'origin', 'main'); };
const runMeta = () => JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'run-1'").get() as { metadata: string }).metadata);
const events = (t: string) => (db.prepare('SELECT COUNT(*) n FROM loop_events WHERE event_type = ?').get(t) as { n: number }).n;

it('B8-FRESH: off (default) is unchanged — stale main still opens the PR and nothing is recorded', async () => {
  mainMoves();
  expect(await new LoopDraftPrService(db, ok() as unknown as typeof fetch, env()).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(runMeta().evidence_freshness).toBeUndefined();
  expect(events('evidence_stale') + events('evidence_stale_shadow')).toBe(0);
});

it('B8-FRESH: shadow records stale evidence but still opens the PR', async () => {
  mainMoves();
  expect(await new LoopDraftPrService(db, ok() as unknown as typeof fetch, env('shadow')).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(runMeta().evidence_freshness).toMatchObject({ state: 'stale', mode: 'shadow', changed: ['tsconfig.json'] });
  expect(events('evidence_stale_shadow')).toBe(1);
});

it('B8-FRESH: enforce does not open the PR on stale evidence and marks the run for a re-check', async () => {
  mainMoves();
  const f = ok();
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env('enforce')).openForRun('run-1')).toBeNull();
  expect(f).not.toHaveBeenCalled();
  expect(runMeta().evidence_freshness).toMatchObject({ state: 'stale', mode: 'enforce', requeue: true });
  expect(runMeta().pr_url).toBeUndefined();
  expect(events('evidence_stale')).toBe(1);
});

it('B8-FRESH: a fresh read set opens the PR in enforce and records state fresh', async () => {
  const f = ok();
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env('enforce')).openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(runMeta().evidence_freshness).toMatchObject({ state: 'fresh', changed: [] });
});
