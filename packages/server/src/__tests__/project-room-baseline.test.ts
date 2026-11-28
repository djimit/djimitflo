import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

/**
 * Uses only modules that exist before the project room, so on the baseline it fails on the missing BEHAVIOUR (the maker is
 * handed over without a plan; no immutable plan store), not on a missing import.
 */
let root = '';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

it('mode on: a goal that selected the project room is not handed to a maker without a plan; other goals are', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-room-base-')); const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', 'init');
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees')); vi.stubEnv('COMMONS_PROJECT_ROOM_MODE', 'on');
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
  const loops = new LoopService(db, path.join(root, 'evidence'));
  const now = new Date().toISOString();
  const goal = (id: string, metadata: string) => db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, created_at, updated_at) VALUES (?, 'improve wording', 'low', 'running', ?, ?, ?)`).run(id, metadata, now, now);
  goal('room', '{"task_profile":"project_room"}'); goal('direct', '{}');
  const start = (goalId: string) => loops.startDocDriftAndSmallFixLoop({ repository_path: repo, goal_id: goalId, target_finding: { file_path: 'README.md', description: 'Improve wording', category: 'refactor' } });
  expect(() => loops.continueLoopRun(start('room').id, { runtime: 'mock', max_assignments: 1, max_maker_workers: 1 })).toThrow(/PROJECT_ROOM_PLAN_REQUIRED/);
  expect(loops.continueLoopRun(start('direct').id, { runtime: 'mock', max_assignments: 1, max_maker_workers: 1 }).leases.some((l) => l.role === 'maker')).toBe(true);
  db.close();
});

it('issued plan versions cannot be changed or removed', () => {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); runMigrations(db); // idempotent
  db.prepare("INSERT INTO project_room_artifacts (id, goal_id, kind, version, digest, payload_json, created_at) VALUES ('a', 'g', 'plan', 1, 'd', '{}', 'now')").run();
  expect(() => db.prepare("UPDATE project_room_artifacts SET digest = 'x'").run()).toThrow(/PROJECT_ROOM_ARTIFACT_IMMUTABLE/);
  expect(() => db.prepare('DELETE FROM project_room_artifacts').run()).toThrow(/PROJECT_ROOM_ARTIFACT_IMMUTABLE/);
  expect(() => db.prepare("INSERT INTO project_room_artifacts (id, goal_id, kind, version, digest, payload_json, created_at) VALUES ('b', 'g', 'plan', 1, 'd', '{}', 'now')").run()).toThrow(/UNIQUE/);
  db.close();
});
