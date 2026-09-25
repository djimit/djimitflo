import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { SelfImprovementService } from '../services/self-improvement-service';

/**
 * generateFromBuildErrors() existed but was never called anywhere in
 * production (found 2026-09-20 alongside the discovery that 0 of 357
 * self-improvement proposals ever reached 'goal', all from vague reflection
 * text). This covers the new wiring in runDeterministicChecks(): a failed
 * check should create a real, concrete self-improvement proposal; a clean
 * run should create none.
 */
describe('LoopService deterministic checks -> self-improvement wiring', () => {
  let db: Database.Database;
  let loops: LoopService;
  let worktree: string;
  let evidenceRoot: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-build-error-wiring-'));
    evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-build-error-evidence-'));
    loops = new LoopService(db, evidenceRoot);
  });

  afterEach(() => {
    db?.close();
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  });

  function seedLoopRunWithMakerLease(runId: string, leaseId: string) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, 'repo-maintenance-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{"risk_class":"low"}', now, now);
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(leaseId, runId, 'maker', 'codex', 'completed', worktree, '{}', now, now);
  }

  it('creates a concrete self-improvement proposal from a failed deterministic check', () => {
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.stderr.write(\'boom: unexpected token\\n\'); process.exit(1)"' } }));
    seedLoopRunWithMakerLease('run-fail', 'lease-fail');

    loops.runDeterministicChecks('run-fail', { lease_id: 'lease-fail', scripts: ['lint'] });

    const improvements = new SelfImprovementService(db);
    const proposals = improvements.listImprovements();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].type).toBe('bug_fix');
    expect(proposals[0].source).toBe('feedback');
    expect(proposals[0].description).toContain('lint failed');
    expect(proposals[0].description).toContain('boom: unexpected token');
  });

  it('creates no self-improvement proposal when all deterministic checks pass', () => {
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"' } }));
    seedLoopRunWithMakerLease('run-pass', 'lease-pass');

    loops.runDeterministicChecks('run-pass', { lease_id: 'lease-pass', scripts: ['lint'] });

    const improvements = new SelfImprovementService(db);
    expect(improvements.listImprovements()).toHaveLength(0);
  });

  it('creates no self-improvement proposal when the script is simply not present (skipped, not failed)', () => {
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ scripts: {} }));
    seedLoopRunWithMakerLease('run-skip', 'lease-skip');

    loops.runDeterministicChecks('run-skip', { lease_id: 'lease-skip', scripts: ['lint'] });

    const improvements = new SelfImprovementService(db);
    expect(improvements.listImprovements()).toHaveLength(0);
  });
});
