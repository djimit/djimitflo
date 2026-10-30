/**
 * O2b (re-20261029 C-reliability §1b / candidate 8): 471 reviewer cancels carried no reason and 47 maker failures (18 %)
 * read unknown. Every lease cancel names a reason: the shared settle helper (WorkerLeaseRepo.updateStatus) defaults an
 * unstated one to `cascade:run_<status>` (the run's status when the lease was settled) instead of 'unspecified', and every
 * raw SQL cancel binds CANCEL_LEASE_METADATA_SQL (or sets cancellation_reason itself). A source scan keeps it that way.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

describe('the settle helper always records a cancellation_reason', () => {
  let db: Database.Database; let loops: LoopService; let root: string;
  beforeEach(() => {
    db = new Database(':memory:'); db.exec(schema); runMigrations(db); db.pragma('foreign_keys = OFF');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-reason-'));
    loops = new LoopService(db, path.join(root, 'evidence'));
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const lease = (id: string, runId: string) => loops.insertWorkerLease({ id, loopRunId: runId, role: 'checker', runtime: 'manual', findingId: null, worktreePath: null, branchName: null, now: new Date().toISOString(), metadata: {} });
  const run = (id: string, status: string) => db.prepare("INSERT INTO loop_runs(id,loop_name,mode,status,findings_json,metadata) VALUES(?, 'doc-drift-and-small-fix-loop', 'closed', ?, '[]', '{}')").run(id, status);
  const meta = (id: string) => loops.getWorkerLease(id).metadata as { cancellation_reason?: string; failure?: { cancellation_reason?: string } };

  it('an unstated cancel defaults to cascade:run_<status> (was: unspecified)', () => {
    run('r1', 'blocked'); lease('l1', 'r1');
    loops.updateWorkerLeaseStatus('l1', 'cancelled', {});
    expect(meta('l1').cancellation_reason).toBe('cascade:run_blocked');
    expect(meta('l1').failure?.cancellation_reason).toBe('cascade:run_blocked');
    run('r2', 'cancelled'); lease('l2', 'r2');
    loops.updateWorkerLeaseStatus('l2', 'cancelled', {});
    expect(meta('l2').cancellation_reason).toBe('cascade:run_cancelled');
  });

  it('a stated or derivable reason wins; a lease without a run keeps the explicit unspecified marker', () => {
    run('r1', 'blocked'); lease('l1', 'r1'); lease('l2', 'r1'); lease('l3', 'gone');
    loops.updateWorkerLeaseStatus('l1', 'cancelled', { cancellation_reason: 'operator_stop' });
    loops.updateWorkerLeaseStatus('l2', 'cancelled', { superseded_by_maker_lease_id: 'm2' });
    loops.updateWorkerLeaseStatus('l3', 'cancelled', {});
    expect(meta('l1').cancellation_reason).toBe('operator_stop');
    expect(meta('l2').cancellation_reason).toBe('superseded');
    expect(meta('l3').cancellation_reason).toBe('unspecified: caller supplied no reason');
  });
});

describe('source scan: no lease cancel path lacks a reason', () => {
  const SRC = path.resolve(__dirname, '..');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : files(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
  /** Each SQL statement (the string literal it sits in) that updates worker_leases. */
  const statements = () => files(SRC).flatMap((abs) => {
    const src = fs.readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rel = path.relative(SRC, abs).split(path.sep).join('/');
    const out: Array<{ file: string; sql: string }> = [];
    for (const m of src.matchAll(/UPDATE\s+worker_leases\s+SET\b/g)) {
      const before = src.slice(0, m.index).trimEnd(); const quote = before.at(-1)!;
      if (!['`', "'", '"'].includes(quote)) continue; // not the start of a string literal
      const end = src.indexOf(quote, m.index!);
      out.push({ file: rel, sql: src.slice(m.index!, end < 0 ? undefined : end) });
    }
    return out;
  });

  it('every raw cancel of a lease records cancellation_reason (CANCEL_LEASE_METADATA_SQL or its own)', () => {
    const cancels = statements().filter((s) => /\bstatus\s*=\s*'cancelled'/.test(s.sql));
    expect(cancels.length).toBeGreaterThan(5);
    expect(cancels.filter((s) => !/CANCEL_LEASE_METADATA_SQL|cancellation_reason/.test(s.sql)).map((s) => `${s.file}: ${s.sql.replace(/\s+/g, ' ').slice(0, 120)}`)).toEqual([]);
  });

  it('a bound status (SET status = ?) outside the settle helper is listed with why it cannot cancel without a reason', () => {
    const BOUND: Record<string, string> = {
      'services/loop-worker-lease-repo.ts': 'the shared settle helper itself (defaults the reason)',
      'services/cs-skill-swarm-harness-service.ts': "typed 'running' | 'completed' | 'failed' — never cancels",
      'services/swarm-status-service.ts': "operator lease stop: metadata carries cancellation_reason 'operator_lease_stop'",
    };
    const bound = [...new Set(statements().filter((s) => /\bSET\s+status\s*=\s*\?/.test(s.sql)).map((s) => s.file))].sort();
    expect(bound).toEqual(Object.keys(BOUND).sort());
  });
});
