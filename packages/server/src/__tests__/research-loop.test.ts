import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

let db: Database.Database;
let loops: LoopService;
let tempDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  try { db.exec('ALTER TABLE worker_leases ADD COLUMN confidence REAL DEFAULT 0.5'); } catch { /* ok */ }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g39-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'test' }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
  execFileSync('git', ['add', '.'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });
  loops = new LoopService(db);
});

afterEach(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('G39: Research Loop', () => {
  it('routes preregistered work through the governed research contract', () => {
    const run = loops.startLoop({ loop_name: 'research-loop', repository_path: tempDir });
    const contract = loops.getCatalog().loops.find(({ name }) => name === 'research-loop');

    expect(run).toMatchObject({ loop_name: 'research-loop', status: 'completed', findings: [] });
    expect(contract).toMatchObject({ risk_class: 'medium', status: 'implemented' });
    expect(contract?.actions_forbidden).toContain('production_mutation');
  });
});
