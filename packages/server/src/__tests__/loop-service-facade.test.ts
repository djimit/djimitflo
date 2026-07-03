import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

/**
 * Phase 1.2: LoopService delegation tests.
 * These verify current behavior so decomposition (Phase 2) doesn't regress.
 * Each test maps to a delegation target that will become a sub-service.
 */

describe('LoopService delegation contract', () => {
  let db: Database.Database;
  let service: LoopService;
  let tempDir: string;
  let evidenceDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-facade-'));
    evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-evidence-'));
    service = new LoopService(db, evidenceDir);

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: fix this\n');
    fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
    execFileSync('git', ['add', '.'], { cwd: tempDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'ignore' });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(evidenceDir, { recursive: true, force: true });
  });

  describe('lifecycle delegation (→ LoopOrchestrationService)', () => {
    it('startDocDriftAndSmallFixLoop creates a run with findings', () => {
      const run = service.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
      expect(run.id).toBeDefined();
      expect(['running', 'completed']).toContain(run.status);
      expect(run.findings.length).toBeGreaterThan(0);
    });

    it('getLoopRun returns the started run', () => {
      const run = service.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
      const fetched = service.getLoopRun(run.id);
      expect(fetched.id).toBe(run.id);
      expect(fetched.loop_name).toBe(run.loop_name);
    });

    it('continueLoopRun prepares maker and checker leases', () => {
      const run = service.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
      const continued = service.continueLoopRun(run.id, { runtime: 'mock' });
      expect(continued.leases.length).toBeGreaterThan(0);
      expect(continued.leases.some(l => l.role === 'maker')).toBe(true);
    });
  });

  describe('verification delegation (→ LoopVerificationService)', () => {
    it('verifyLoopRun returns gates', () => {
      const run = service.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
      const verified = service.verifyLoopRun(run.id);
      expect(verified.gates).toBeDefined();
      expect(Array.isArray(verified.gates)).toBe(true);
    });

    it('certifyLoopRun returns certified boolean', () => {
      const run = service.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
      const result = service.certifyLoopRun(run.id);
      expect(result).toHaveProperty('certified');
      expect(typeof result.certified).toBe('boolean');
    });
  });

  describe('budget delegation (→ LoopBudgetService)', () => {
    it('computeDollarCost returns a number', () => {
      const cost = service.computeDollarCost('mock', 1000);
      expect(typeof cost).toBe('number');
      expect(cost).toBeGreaterThanOrEqual(0);
    });

    it('computeEfficiencyMetric returns efficiency object for a run', () => {
      const run = service.startDocDriftAndSmallFixLoop({ repository_path: tempDir });
      const metric = service.computeEfficiencyMetric(run.id);
      expect(metric).toHaveProperty('verifiedArtifacts');
      expect(metric).toHaveProperty('dollarsSpent');
      expect(metric).toHaveProperty('efficiency');
      expect(typeof metric.efficiency).toBe('number');
    });
  });

  describe('error handling delegation', () => {
    it('throws LOOP_RUN_NOT_FOUND for unknown run', () => {
      expect(() => service.getLoopRun('nonexistent-id')).toThrow('LOOP_RUN_NOT_FOUND');
    });

    it('throws on continue for unknown run', () => {
      expect(() => service.continueLoopRun('nonexistent-id', {})).toThrow();
    });
  });
});
