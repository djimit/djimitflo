import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { RemoteMakerQueue } from '../services/remote-maker-queue';
import { cvManifestSha, cvTaskKeys, makerJobsWaiting, type CvManifest } from '../services/cv-001';

const now = '2026-11-08T00:30:00.000Z';

const manifest = (overrides: Partial<CvManifest> = {}): CvManifest => ({
  id: 'cv-001',
  protocol: 'docs/research/cv-001/CV-001_PROTOCOL.md',
  prereg_sha256: 'b6e1bb318557464e49d6cef8663c5730a1d56dc396c6e471324e556faf25771c',
  frozen_at: now,
  commit: null,
  harness: null,
  species: 'atomic@llama-router',
  step_budget: 40,
  flags: {},
  evaluator: { prod_gates: true },
  treatment: { aliases: { A: 'qwen38-27b', B: 'qwen38-27b-cvd15' }, vector_sha256: 'db1893a4d12936fefedb98d117955ef6cc7b1d59c661c1e44f6eee590cda4281', scale: 1.5, layer_range: null },
  tasks: [],
  schedule: { repeats: 2, block_size: 6, units: 0, slots: [] },
  pool: { candidates: 0, eligible: 0, excluded: {} },
  analysis: {
    hypothesis: 'H-CV1', primary: 'clean success', test: 'mcnemar', alpha: 0.05, rules: [], verdicts: { ADOPT: '', REJECT: '', INCONCLUSIVE: '' }, max_days: 28, retry_policy: '',
  },
  ...overrides,
});

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(schema);
  runMigrations(db);
  new RemoteMakerQueue(db);
});

afterEach(() => {
  db.close();
});

describe('makerJobsWaiting', () => {
  const job = (id: string, status: string) => db.prepare(
    "INSERT INTO remote_maker_jobs (id, host, species, base_commit, prompt, status, created_at) VALUES (?, 'host', 'atomic@llama-router', 'c', 'p', ?, ?)",
  ).run(id, status, now);

  it('returns 0 when no jobs are queued or claimed', () => {
    expect(makerJobsWaiting(db)).toBe(0);
  });

  it('counts only queued and claimed jobs', () => {
    job('j1', 'queued');
    job('j2', 'claimed');
    job('j3', 'finished');
    job('j4', 'cancelled');
    expect(makerJobsWaiting(db)).toBe(2);
  });

  it('returns null when the remote_maker_jobs table is unreadable', () => {
    db.exec('DROP TABLE remote_maker_jobs');
    expect(makerJobsWaiting(db)).toBeNull();
  });
});

describe('cvManifestSha', () => {
  it('is deterministic for the same manifest', () => {
    const m = manifest();
    expect(cvManifestSha(m)).toBe(cvManifestSha(m));
  });

  it('is a 64-char hex sha256', () => {
    expect(cvManifestSha(manifest())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a field changes', () => {
    const a = cvManifestSha(manifest());
    const b = cvManifestSha(manifest({ commit: 'deadbeef' }));
    expect(a).not.toBe(b);
  });

  it('is stable across deep-equal manifests with different insertion order', () => {
    const m = manifest();
    const same = JSON.parse(JSON.stringify(m)) as CvManifest;
    expect(cvManifestSha(m)).toBe(cvManifestSha(same));
  });
});

describe('cvTaskKeys', () => {
  const attempt = (id: string, key: string, repeat = 1, arm: 'A' | 'B' = 'A') => db.prepare(
    "INSERT INTO cv_attempts (id, experiment_id, task_key, repeat, arm, block, seq, status, updated_at) VALUES (?, 'cv-001', ?, ?, ?, 0, 0, 'pending', ?)",
  ).run(id, key, repeat, arm, now);

  it('returns an empty set when no attempts exist', () => {
    expect(cvTaskKeys(db)).toEqual(new Set());
  });

  it('returns the distinct task keys from cv_attempts', () => {
    attempt('a1', 'key-1');
    attempt('a2', 'key-2');
    attempt('a3', 'key-1', 2); // same key, different repeat collapses
    expect(cvTaskKeys(db)).toEqual(new Set(['key-1', 'key-2']));
  });

  it('returns an empty set when cv_attempts is unreadable', () => {
    db.exec('DROP TABLE cv_attempts');
    expect(cvTaskKeys(db)).toEqual(new Set());
  });
});
