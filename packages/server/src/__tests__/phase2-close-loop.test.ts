import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { betaSample } from '../services/self-improvement-service';
import { PanelCalibrationService } from '../services/panel-calibration-service';
import { WorkerLeaseRepo } from '../services/loop-worker-lease-repo';

describe('betaSample', () => {
  it('has the right mean and stays in (0,1)', () => {
    let seed = 42;
    const rng = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const draws = Array.from({ length: 4000 }, () => betaSample(3, 7, rng));
    expect(draws.every((x) => x > 0 && x < 1)).toBe(true);
    expect(draws.reduce((a, b) => a + b, 0) / draws.length).toBeCloseTo(0.3, 1);
  });
});

describe('PanelCalibrationService', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  function proposal(id: string, status: string, reviews: Array<[string, string, number]>) {
    db.prepare("INSERT INTO specialist_panels (id, topic, question, status, risk_class, created_at, updated_at) VALUES (?, 't', 'q', 'consensus_ready', 'low', datetime('now'), datetime('now'))").run(`p-${id}`);
    db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, panel_id, created_at, updated_at) VALUES (?, 'feature', 't', 'd', 'r', 'reflection', ?, 0.5, ?, datetime('now'), datetime('now'))").run(id, status, `p-${id}`);
    reviews.forEach(([spec, stance, conf], i) => db.prepare("INSERT INTO specialist_reviews (id, panel_id, specialist_id, specialist_title, stance, confidence, status) VALUES (?, ?, ?, ?, ?, ?, 'submitted')").run(`r-${id}-${i}`, `p-${id}`, spec, spec, stance, conf));
  }

  it('scores support/oppose against outcomes and ignores proposals without an outcome', () => {
    proposal('a', 'verified', [['arch', 'support', 0.9]]);       // p=.9,y=1 -> .01
    proposal('b', 'no_change', [['arch', 'support', 0.8]]);      // p=.8,y=0 -> .64
    proposal('c', 'regressed', [['arch', 'oppose', 0.9]]);       // p=.1,y=0 -> .01
    proposal('d', 'needs_more_evidence', [['arch', 'support', 0.9]]); // no outcome yet
    const [arch] = new PanelCalibrationService(db).compute();
    expect(arch.specialistId).toBe('arch');
    expect(arch.n).toBe(3);
    expect(arch.brier).toBeCloseTo((0.01 + 0.64 + 0.01) / 3, 5);
    expect(arch.observedSuccessRate).toBeCloseTo(1 / 3, 5);
  });

  it('returns nothing when no proposal has an outcome', () => {
    proposal('a', 'needs_more_evidence', [['arch', 'support', 0.9]]);
    expect(new PanelCalibrationService(db).compute()).toEqual([]);
  });
});

describe('worker lease failure reasons', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  const lease = (id: string) => {
    db.prepare("INSERT OR IGNORE INTO loop_runs (id, loop_name, mode, status) VALUES ('run-x', 'doc-drift-and-small-fix-loop', 'closed', 'planning')").run();
    db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, 'run-x', 'maker', 'mock', 'running', '{}', datetime('now'), datetime('now'))").run(id);
  };
  const reason = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(id) as { metadata: string }).metadata).failure_reason;

  it('never records a failure without a reason', () => {
    const repo = new WorkerLeaseRepo(db);
    lease('a'); lease('b'); lease('c'); lease('d');
    repo.updateStatus('a', 'failed', { exit_status: 2 });
    repo.updateStatus('b', 'failed', { timed_out: true });
    repo.updateStatus('c', 'failed', { failure_reason: 'explicit' });
    repo.updateStatus('d', 'failed');
    expect([reason('a'), reason('b'), reason('c'), reason('d')]).toEqual(['runtime_exit_status_2', 'runtime_timed_out', 'explicit', 'unspecified: caller supplied no reason']);
  });
});
