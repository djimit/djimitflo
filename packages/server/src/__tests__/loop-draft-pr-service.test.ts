import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopDraftPrService } from '../services/loop-draft-pr-service';

let db: Database.Database; let wt: string; let remote: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const env = () => ({ LOOP_AUTO_DRAFT_PR_ENABLED: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't0ken' });
const ok = () => vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/pull/9' }) });

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftpr-'));
  remote = path.join(root, 'remote.git'); wt = path.join(root, 'wt');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', wt]);
  fs.writeFileSync(path.join(wt, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{}\n');
  git(wt, 'add', '.'); git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'); git(wt, 'remote', 'add', 'origin', remote);
  // maker output + the noise a worktree carries
  fs.mkdirSync(path.join(wt, 'src')); fs.writeFileSync(path.join(wt, 'src', 'x.test.ts'), 'it("x", () => {});\n');
  fs.symlinkSync(root, path.join(wt, 'node_modules'));
  fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"noise":true}\n');

  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('run-1', 'doc-drift-and-small-fix-loop', 'closed', 'ready_for_human_merge', '[]', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, branch_name, metadata, created_at, updated_at) VALUES ('m1', 'run-1', 'maker', 'opencode', 'completed', ?, 'agent/loop/run-1', '{}', ?, ?)`).run(wt, now, now);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('c1', 'run-1', 'checker', 'opencode', 'completed', '{"verdict":"accepted"}', ?, ?)`).run(now, now);
});
afterEach(() => { db.close(); });

it('does nothing unless LOOP_AUTO_DRAFT_PR_ENABLED', async () => {
  const f = ok();
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, {}).openForRun('run-1')).toBeNull();
  expect(f).not.toHaveBeenCalled();
});

it('pushes only the maker files and opens one draft PR per run', async () => {
  const f = ok(); const svc = new LoopDraftPrService(db, f as unknown as typeof fetch, env());
  expect(await svc.openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(git(remote, 'ls-tree', '-r', '--name-only', 'agent/loop/run-1').split('\n').sort()).toEqual(['.gitignore', 'package-lock.json', 'src/x.test.ts']);
  expect(git(remote, 'show', 'agent/loop/run-1:package-lock.json')).toBe('{}'); // lockfile noise not committed
  const req = JSON.parse(f.mock.calls[0][1].body as string);
  expect(req).toMatchObject({ head: 'agent/loop/run-1', base: 'main', draft: true });
  expect(req.body).toContain('checker: accepted');
  expect(fs.readFileSync(path.join(wt, '.git', 'config'), 'utf8')).not.toContain('t0ken'); // token never persisted
  expect(await svc.openForRun('run-1')).toBe('https://github.com/o/r/pull/9');
  expect(f).toHaveBeenCalledTimes(1);
});

it('records draft_pr_failed instead of throwing when GitHub refuses', async () => {
  const f = vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({}) });
  expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, env()).openForRun('run-1')).toBeNull();
  expect(db.prepare("SELECT message FROM loop_events WHERE event_type = 'draft_pr_failed'").get()).toEqual({ message: 'Draft PR not opened: GitHub 422' });
});
