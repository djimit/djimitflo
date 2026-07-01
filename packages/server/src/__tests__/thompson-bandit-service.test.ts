import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ThompsonBanditService } from '../services/thompson-bandit-service';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let bandit: ThompsonBanditService;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  bandit = new ThompsonBanditService(db);
});

afterEach(() => {
  db?.close();
});

describe('G45: Thompson Sampling Bandit', () => {
  it('returns codex for unknown capability', () => {
    const runtime = bandit.selectArm('unknown-cap');
    expect(runtime).toBe('codex');
  });

  it('creates arm on first recordOutcome', () => {
    bandit.recordOutcome('cap-a', 'codex', true);
    const dist = bandit.getDistribution('cap-a', 'codex');
    expect(dist.alpha).toBe(2.0);
    expect(dist.beta).toBe(1.0);
    expect(dist.totalTrials).toBe(1);
  });

  it('updates alpha on success', () => {
    bandit.recordOutcome('cap-a', 'codex', true);
    bandit.recordOutcome('cap-a', 'codex', true);
    const dist = bandit.getDistribution('cap-a', 'codex');
    expect(dist.alpha).toBe(3.0);
    expect(dist.beta).toBe(1.0);
  });

  it('updates beta on failure', () => {
    bandit.recordOutcome('cap-a', 'codex', false);
    const dist = bandit.getDistribution('cap-a', 'codex');
    expect(dist.alpha).toBe(1.0);
    expect(dist.beta).toBe(2.0);
  });

  it('tracks multiple runtimes', () => {
    bandit.recordOutcome('cap-a', 'codex', true);
    bandit.recordOutcome('cap-a', 'opencode', false);
    const stats = bandit.getArmStats('cap-a');
    expect(stats.arms.length).toBe(2);
  });

  it('getArmStats returns best runtime', () => {
    for (let i = 0; i < 10; i++) bandit.recordOutcome('cap-b', 'codex', true);
    for (let i = 0; i < 10; i++) bandit.recordOutcome('cap-b', 'opencode', false);
    const stats = bandit.getArmStats('cap-b');
    expect(stats.bestRuntime).toBe('codex');
  });

  it('decayAll reduces alpha', () => {
    for (let i = 0; i < 60; i++) bandit.recordOutcome('cap-c', 'codex', i < 50);
    const before = bandit.getDistribution('cap-c', 'codex');
    expect(before.alpha).toBeGreaterThan(10);
    expect(before.beta).toBeGreaterThan(5);
    bandit.decayAll(0.5);
    const after = bandit.getDistribution('cap-c', 'codex');
    expect(after.alpha).toBeLessThan(before.alpha);
    expect(after.beta).toBeLessThan(before.beta);
  });

  it('decay never goes below 1.0', () => {
    bandit.recordOutcome('cap-d', 'codex', true);
    for (let i = 0; i < 10; i++) bandit.decayAll(0.01);
    const dist = bandit.getDistribution('cap-d', 'codex');
    expect(dist.alpha).toBeGreaterThanOrEqual(1.0);
    expect(dist.beta).toBeGreaterThanOrEqual(1.0);
  });

  it('getTrialsCount sums all arms', () => {
    bandit.recordOutcome('cap-e', 'codex', true);
    bandit.recordOutcome('cap-e', 'opencode', true);
    bandit.recordOutcome('cap-e', 'claude', true);
    expect(bandit.getTrialsCount('cap-e')).toBe(3);
  });

  it('getTrialsCount returns 0 for unknown', () => {
    expect(bandit.getTrialsCount('nonexistent')).toBe(0);
  });

  it('selectArm prefers higher success rate over many trials', () => {
    for (let i = 0; i < 20; i++) bandit.recordOutcome('cap-f', 'codex', i < 18);
    for (let i = 0; i < 5; i++) bandit.recordOutcome('cap-f', 'opencode', i < 2);
    let codexWins = 0;
    for (let i = 0; i < 200; i++) {
      if (bandit.selectArm('cap-f') === 'codex') codexWins++;
    }
    expect(codexWins).toBeGreaterThan(100);
  });

  it('confidence increases with trials', () => {
    for (let i = 0; i < 3; i++) bandit.recordOutcome('cap-g', 'codex', true);
    const low = bandit.getArmStats('cap-g');
    for (let i = 0; i < 25; i++) bandit.recordOutcome('cap-g', 'codex', true);
    const high = bandit.getArmStats('cap-g');
    expect(high.confidence).toBeGreaterThan(low.confidence);
  });

  it('convergence simulation: best runtime has highest observed success rate', () => {
    bandit.recordOutcome('cap-conv', 'codex', false);
    bandit.recordOutcome('cap-conv', 'codex', false);
    bandit.recordOutcome('cap-conv', 'codex', true);
    bandit.recordOutcome('cap-conv', 'opencode', true);
    bandit.recordOutcome('cap-conv', 'opencode', false);
    bandit.recordOutcome('cap-conv', 'claude', true);
    bandit.recordOutcome('cap-conv', 'claude', true);
    bandit.recordOutcome('cap-conv', 'claude', true);
    bandit.recordOutcome('cap-conv', 'claude', false);

    const stats = bandit.getArmStats('cap-conv');
    expect(stats.bestRuntime).toBe('claude');
  });

  it('persists across service instances', () => {
    bandit.recordOutcome('cap-persist', 'codex', true);
    const bandit2 = new ThompsonBanditService(db);
    const dist = bandit2.getDistribution('cap-persist', 'codex');
    expect(dist.totalTrials).toBe(1);
  });
});
