import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clusterBootstrap, costPerSuccess, mcnemarExact, newcombePaired, pairedRatioBootstrap, shuffle, wilson } from '../services/asg/harness/stats';
import { familySplit, fixtureTasks } from '../services/asg/harness/fixtures';
import { runPilot } from '../services/asg/harness/run';
import { analyse } from '../services/asg/harness/analyse';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

describe('ASG-001 statistics (PREREG §5)', () => {
  it('exact McNemar: two-sided binomial on the discordant pairs', () => {
    expect(mcnemarExact(0, 0).p).toBe(1);
    expect(mcnemarExact(0, 6).p).toBeCloseTo(2 / 64, 12);
    expect(mcnemarExact(1, 8).p).toBeCloseTo(20 / 512, 12);
    expect(mcnemarExact(5, 5).p).toBe(1);
  });
  it('cost per success: ratio of sums over every attempt; zero successes is +Infinity, never 0', () => {
    expect(costPerSuccess([{ cluster: 'a', cost: 3, success: false }, { cluster: 'a', cost: 5, success: true }])).toBe(8);
    expect(costPerSuccess([{ cluster: 'a', cost: 3, success: false }])).toBe(Infinity);
    expect(costPerSuccess([])).toBe(Infinity);
  });
  it('cluster bootstrap resamples clusters, is seeded, and keeps +Infinity draws', () => {
    const rows = [{ cluster: 'a', cost: 2, success: true }, { cluster: 'b', cost: 4, success: false }, { cluster: 'c', cost: 3, success: true }];
    const x = clusterBootstrap(rows, costPerSuccess, 2000, 7); const y = clusterBootstrap(rows, costPerSuccess, 2000, 7);
    expect(x).toEqual(y);
    expect(x.estimate).toBe(4.5);
    expect(x.infinite_draws).toBeGreaterThan(0); // draws of only cluster b
    expect(x.ci![1]).toBe(Infinity);
    expect(clusterBootstrap(rows.slice(0, 1), costPerSuccess).ci).toBeNull(); // one cluster: no CI
    expect(pairedRatioBootstrap(rows, rows, 500, 1).estimate).toBe(1);
  });
  it('Newcombe paired interval contains the difference and stays in [-1, 1]', () => {
    for (const [a, b, c, d] of [[13, 0, 0, 2], [7, 0, 6, 2], [5, 3, 1, 6], [0, 0, 0, 10]]) {
      const r = newcombePaired(a, b, c, d)!;
      expect(r.diff).toBeCloseTo((b - c) / (a + b + c + d), 12);
      expect(r.ci[0]).toBeLessThanOrEqual(r.diff); expect(r.ci[1]).toBeGreaterThanOrEqual(r.diff);
      expect(r.ci[0]).toBeGreaterThanOrEqual(-1); expect(r.ci[1]).toBeLessThanOrEqual(1);
    }
    expect(wilson(0, 0)).toBeNull();
  });
  it('seeded shuffle is a permutation and reproducible', () => {
    const xs = Array.from({ length: 30 }, (_, i) => i);
    expect(shuffle(xs, 3)).toEqual(shuffle(xs, 3));
    expect([...shuffle(xs, 3)].sort((p, q) => p - q)).toEqual(xs);
  });
});

describe('ASG-001 fixtures and harness', () => {
  it('splits by family (every variant of a fixture in one split), salt asg-001', () => {
    const tasks = fixtureTasks();
    for (const f of new Set(tasks.map((t) => t.family))) expect(new Set(tasks.filter((t) => t.family === f).map((t) => familySplit(t.family))).size).toBe(1);
    expect(Object.fromEntries([...new Set(tasks.map((t) => t.family))].map((f) => [f, familySplit(f)]))).toEqual({ slug: 'train', money: 'test', clamp: 'train', csvsplit: 'train', dirty: 'dev', pair: 'test', config: 'test' });
  });
  it('every fixture is sound: its solution passes and kills its mutant; the weak starting test does not', async () => {
    const { oracle } = await import('../services/asg/harness/run');
    const { FsWorkspace, snapshot } = await import('../services/asg/effects');
    for (const t of fixtureTasks().filter((x) => x.solvable)) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asg-fx-')); roots.push(root);
      const ws = new FsWorkspace(path.join(root, 'ws'));
      for (const [p, c] of Object.entries(t.files)) ws.write(p, c);
      for (const [p, c] of Object.entries(t.userEdits ?? {})) ws.write(p, c);
      const pristine = snapshot(ws);
      expect(oracle(t, ws, pristine, path.join(root, 's')).verified, `${t.spec.task_id} unsolved start`).toBe(false);
      for (const [p, c] of Object.entries(t.solution)) ws.write(p, c);
      expect(oracle(t, ws, pristine, path.join(root, 's')), t.spec.task_id).toMatchObject({ verified: true });
    }
  });
  it('a small pilot runs paired arms in fresh workspaces; B–E have zero invariant violations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asg-pilot-')); roots.push(root);
    const tasks = fixtureTasks().filter((t) => ['slug-v1', 'csvsplit-v1', 'config-v1'].includes(t.spec.task_id));
    const { manifest, rows } = runPilot({ root, tasks, conditions: ['natural', 'partial_change', 'after_completion'] });
    expect(manifest).toMatchObject({ experiment: 'ASG-001', kind: 'mechanism_pilot', tasks: 3 });
    expect(rows).toHaveLength(3 * 5 + 3 * 3 * 2); // natural: 5 arms; each macro fault: C, D, E
    expect(new Set(rows.map((r) => r.run_id)).size).toBe(rows.length);
    expect(rows.filter((r) => r.arm !== 'A').flatMap((r) => r.invariant_violations)).toEqual([]);
    expect(rows.find((r) => r.run_id === 'config-v1.A.natural.r1')!.invariant_violations).toEqual(['write_outside_capability:package.json']);
    const a = analyse(rows);
    expect(a.natural.by_arm.E).toMatchObject({ n: 3, verified: 2 });
    expect(a.natural.by_arm.D).toMatchObject({ n: 3, verified: 1 });
    expect(fs.readdirSync(path.join(root, 'ws'))).toEqual([]); // workspaces are removed
  });
});
