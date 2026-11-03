import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

// Prod 2026-09-28: maker worktrees had no node_modules (fresh clone per deploy), so every check exited 127.
let db: Database.Database; let worktree: string; let bin: string; let loops: LoopService; const PATH = process.env.PATH;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-install-'));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-npm-'));
  // fake npm: `ci` creates node_modules (or fails when FAIL exists); `run <s>` passes only once node_modules exists
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\ncase "$1" in\n ci) [ -f "${bin}/FAIL" ] && { echo broken >&2; exit 1; }; mkdir node_modules; echo ci >> "${bin}/log";;\n run) [ -d node_modules ] || { echo "vitest: not found" >&2; exit 127; };;\nesac\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${PATH}`;
  fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ scripts: { 'test:changed': 'vitest run' } }));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
    VALUES ('r', 'repo-maintenance-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, metadata, created_at, updated_at)
    VALUES ('l', 'r', 'maker', 'codex', 'completed', ?, '{}', ?, ?)`).run(worktree, now, now);
  loops = new LoopService(db, fs.mkdtempSync(path.join(os.tmpdir(), 'checks-ev-')));
});
afterEach(() => { process.env.PATH = PATH; db.close(); fs.rmSync(worktree, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); });
const statuses = () => loops.runDeterministicChecks('r', { lease_id: 'l', scripts: ['test:changed'] }).checks.map((c) => `${c.name}:${c.status}`);

it('installs dependencies before the checks when the worktree has a lockfile but no node_modules', () => {
  fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{}');
  expect(statuses()).toEqual(['test:changed:pass']);
  expect(fs.readFileSync(path.join(bin, 'log'), 'utf8')).toBe('ci\n');
});

it('reports a failed install as its own check', () => {
  fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{}'); fs.writeFileSync(path.join(bin, 'FAIL'), '');
  expect(statuses()).toEqual(['install:fail', 'test:changed:fail']);
});

it('leaves a worktree without a lockfile alone', () => {
  expect(statuses()).toEqual(['test:changed:fail']);
  expect(fs.existsSync(path.join(bin, 'log'))).toBe(false);
});

it('leaves a worktree that already has dependencies alone', () => {
  fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{}'); fs.mkdirSync(path.join(worktree, 'node_modules'));
  expect(statuses()).toEqual(['test:changed:pass']);
  expect(fs.existsSync(path.join(bin, 'log'))).toBe(false);
});
