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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-g13-'));
  fs.writeFileSync(path.join(tempDir, 'README.md'), 'TODO: document this module\n');
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({
    scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'type-check': 'node -e "process.exit(0)"' },
  }, null, 2));
  execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'g13-test@example.invalid'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'G13 Test'], { cwd: tempDir });
  execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: tempDir });
  execFileSync('git', ['commit', '-m', 'Initial test repo'], { cwd: tempDir, stdio: 'ignore' });
  loops = new LoopService(db, '/tmp/djimitflo-test-evidence');
});

afterEach(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('G13: Dollar economy', () => {
  it('computes dollar cost from token usage × price per token', () => {
    // 1M tokens on codex at $2/Mtok = $2
    const cost = (loops as any).computeDollarCost('codex', 1_000_000);
    expect(cost).toBeCloseTo(2.0, 2);
  });

  it('computes pi as free ($0)', () => {
    const cost = (loops as any).computeDollarCost('pi', 1_000_000);
    expect(cost).toBe(0);
  });

  it('computes opencode as cheaper than codex', () => {
    const codexCost = (loops as any).computeDollarCost('codex', 500_000);
    const opencodeCost = (loops as any).computeDollarCost('opencode', 500_000);
    expect(opencodeCost).toBeLessThan(codexCost);
  });

  it('allocates dollar budget across findings (greedy knapsack)', () => {
    const findings = [
      { finding_id: 'f1', capability_id: 'cap-a', p50_dollars: 0.50, competence: 0.9 },
      { finding_id: 'f2', capability_id: 'cap-b', p50_dollars: 0.30, competence: 0.7 },
      { finding_id: 'f3', capability_id: 'cap-c', p50_dollars: 0.80, competence: 0.5 },
      { finding_id: 'f4', capability_id: 'cap-d', p50_dollars: 0.10, competence: 0.3 },
    ];

    const result = loops.allocateDollarBudget(findings, 1.0);
    // Best value: f4 (0.3/0.10=3.0), f2 (0.7/0.30=2.33), f1 (0.9/0.50=1.8), f3 (0.5/0.80=0.625)
    // Budget $1.0: f4 ($0.10) + f2 ($0.30) + f1 ($0.50) = $0.90, f3 ($0.80) doesn't fit
    expect(result.allocated).toContain('f4');
    expect(result.allocated).toContain('f2');
    expect(result.allocated).toContain('f1');
    expect(result.deferred).toContain('f3');
    expect(result.budgetInsufficient).toBe(false);
  });

  it('flags budget_insufficient when no findings fit', () => {
    const findings = [
      { finding_id: 'f1', capability_id: 'cap-a', p50_dollars: 5.0, competence: 0.9 },
    ];
    const result = loops.allocateDollarBudget(findings, 1.0);
    expect(result.allocated).toEqual([]);
    expect(result.budgetInsufficient).toBe(true);
  });

  it('computes efficiency metric (verified_artifacts / dollar)', () => {
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tempDir });

    // Insert a completed maker + checker with token usage.
    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata)
      VALUES (?, ?, 'maker', 'codex', 'completed', 'f1', '/tmp/wt', ?)
    `).run('lease-m1', run.id, JSON.stringify({ runtime_usage: { total_tokens: 500_000 } }));

    db.prepare(`
      INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, finding_id, worktree_path, metadata)
      VALUES (?, ?, 'checker', 'codex', 'completed', 'f1', '/tmp/wt', ?)
    `).run('lease-c1', run.id, JSON.stringify({ runtime_usage: { total_tokens: 100_000 } }));

    const metric = loops.computeEfficiencyMetric(run.id);
    // 1 verified artifact, $1.2 spent (600K tokens × $2/Mtok)
    expect(metric.verifiedArtifacts).toBe(1);
    expect(metric.dollarsSpent).toBeCloseTo(1.2, 2);
    expect(metric.efficiency).toBeCloseTo(1 / 1.2, 2);
  });
});
