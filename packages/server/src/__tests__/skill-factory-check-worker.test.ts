import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { runFactoryChecks } from '../services/skill-factory-check-worker';
let directory: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
describe('factory checker worker isolation', () => {
  it('rejects in-memory DBs rather than silently opening an unrelated database', async () => {
    await expect(runFactoryChecks({database:':memory:',runId:'run',leaseId:'maker'})).rejects.toThrow('SKILL_FACTORY_PERSISTED_DATABASE_REQUIRED');
  });
  it('runs real worker loading and existing-loop failure off-thread, with one active slot and clean retry', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(),'skill-check-worker-'));
    const database = path.join(directory,'fixture.db');
    new Database(database).close(); // Deliberately no loop schema: fail before any worktree or subprocess work.
    const request = {database,runId:'nonexistent',leaseId:'nonexistent'};
    let settled = false;
    const pending = runFactoryChecks(request).catch(error => { settled = true; return error; });
    await expect(runFactoryChecks(request)).rejects.toThrow('SKILL_FACTORY_CHECK_WORKER_BUSY');
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); // Main-thread event loop runs while the real worker initializes/checks.
    expect((await pending).message).toBe('SKILL_FACTORY_CHECKS_FAILED');
    await expect(runFactoryChecks(request)).rejects.toThrow('SKILL_FACTORY_CHECKS_FAILED');
  }, 20000);
  it('executes four real npm subprocess checks off-thread and persists their results', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-check-success-'));
    const database = path.join(directory, 'fixture.db');
    const worktree = path.join(directory, 'repo');
    fs.mkdirSync(worktree);
    execFileSync('git', ['init', '--quiet', worktree]);
    vi.stubEnv('LOOP_EVIDENCE_ROOT', path.join(directory, 'evidence'));
    fs.writeFileSync(path.join(worktree, 'fixture.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('isolated arithmetic', async () => { await new Promise(r => setTimeout(r, 50)); assert.equal(2+2,4); });");
    const names = ['test', 'lint', 'type-check', 'test:skill-package'];
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({name:'isolated-skill-check',version:'1.0.0',private:true,scripts:Object.fromEntries(names.map(name=>[name,'node --test fixture.test.mjs']))}));
    // No lockfile/dependencies: existing install path cannot perform network/package installation.
    expect(fs.existsSync(path.join(worktree, 'package-lock.json'))).toBe(false);
    const db = new Database(database);
    try {
      db.exec(schema);
      runMigrations(db);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO loop_runs(id,loop_name,mode,status,findings_json,plan_json,gates_json,next_actions_json,metadata,created_at,updated_at)
        VALUES ('r','repo-maintenance-loop','closed','running','[]','{}','[]','[]','{}',?,?)`).run(now,now);
      db.prepare(`INSERT INTO worker_leases(id,loop_run_id,role,runtime,status,worktree_path,metadata,created_at,updated_at)
        VALUES ('l','r','maker','codex','completed',?,'{}',?,?)`).run(worktree,now,now);
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 10);
      let result;
      try { result = await runFactoryChecks({database,runId:'r',leaseId:'l',timeoutMs:10000}); }
      finally { clearInterval(timer); }
      expect(result.checks.map(c=>`${c.name}:${c.status}`)).toEqual(names.map(name=>`${name}:pass`));
      expect(ticks).toBeGreaterThan(5);
      const row = db.prepare("SELECT metadata FROM worker_leases WHERE id='l'").get() as {metadata:string};
      expect(JSON.parse(row.metadata).deterministic_checks).toEqual(result.checks);
      expect(db.prepare("SELECT status FROM loop_runs WHERE id='r'").get()).toEqual({status:'verifying'});
      for (const check of result.checks) expect(fs.readFileSync(String(check.stdout_path),'utf8')).toContain('isolated arithmetic');
      const repeated = await runFactoryChecks({database,runId:'r',leaseId:'l',timeoutMs:10000});
      expect(repeated.checks.every(check=>check.status==='pass')).toBe(true);
    } finally { db.close(); }
  }, 30000);

});
