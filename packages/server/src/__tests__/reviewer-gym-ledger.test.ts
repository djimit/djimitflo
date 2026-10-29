/**
 * O2a (re-20261029 C-reliability §3e, candidate 5): reviewer leases (0/217) and remote gym attempts (0/362) had no
 * llm_model_calls row — recordMakerCall was maker-only. Each reviewer lease settle (executeChecker) and each gym report
 * (RemoteGymService.record) now writes one ledger row through the same helper (consumer 'checker' | 'gym'). Unknown tokens
 * stay NULL. A reviewer row mirrors its lease's runtime_usage (the lease is the token owner), so cost/resource/usage
 * readers count it once, as they do the maker mirror.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { RemoteGymService } from '../services/remote-gym-service';
import { LEASE_MIRROR_CONSUMERS, recordMakerCall, recordWorkerCall } from '../services/model-call-ledger';
import { usageEvents } from '../services/cost-ledger';
import { tokenLedger } from '../services/resource-ledger';

type Row = { consumer: string; model: string; provider: string | null; ok: number; tokens_in: number | null; tokens_out: number | null; run_id: string | null; purpose: string | null; status: string | null };
const ledger = (db: Database.Database, consumer: string) => db.prepare('SELECT consumer, model, provider, ok, tokens_in, tokens_out, run_id, purpose, status FROM llm_model_calls WHERE consumer = ? ORDER BY id').all(consumer) as Row[];

describe('recordWorkerCall: the maker helper, generalised', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  it('maker rows are unchanged; checker and gym rows carry their consumer; unknown tokens stay NULL', () => {
    recordMakerCall(db, { runId: 'r1', goalId: null, loopName: 'doc-drift', runtime: 'opencode', meta: { model: 'kimi', runtime_usage: { input_tokens: 10, output_tokens: 5 } }, ace: null, ste: null, durationMs: 1, ok: true });
    recordWorkerCall(db, { consumer: 'checker', role: 'security_checker', runId: 'r1', goalId: null, loopName: 'doc-drift', runtime: 'claude', meta: { model: 'sonnet' }, durationMs: 2, ok: false });
    recordWorkerCall(db, { consumer: 'gym', runId: 'g1', goalId: null, loopName: 'evolution-gym', runtime: 'atomic', provider: 'local', meta: { runtime_usage: { total_tokens: 1200 } }, durationMs: 3, ok: true });
    expect(ledger(db, 'maker')).toEqual([expect.objectContaining({ model: 'kimi', provider: 'opencode', ok: 1, tokens_in: 10, tokens_out: 5, purpose: 'maker:doc-drift', status: 'verified' })]);
    expect(ledger(db, 'checker')).toEqual([expect.objectContaining({ model: 'sonnet', provider: 'claude', ok: 0, tokens_in: null, tokens_out: null, run_id: 'r1', purpose: 'security_checker:doc-drift', status: 'failed' })]);
    expect(ledger(db, 'gym')).toEqual([expect.objectContaining({ model: 'atomic', provider: 'local', ok: 1, tokens_in: 1200, tokens_out: null, run_id: 'g1', purpose: 'gym:evolution-gym', status: 'ok' })]);
  });

  it('a reviewer row is a lease mirror: cost and resource ledgers count its tokens once (from the lease)', () => {
    expect(LEASE_MIRROR_CONSUMERS).toEqual(expect.arrayContaining(['maker', 'checker']));
    const now = new Date().toISOString(); db.pragma('foreign_keys = OFF'); // a lease without its loop_runs row
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES ('c1', 'r1', 'checker', 'claude', 'completed', ?, ?, ?)`)
      .run(JSON.stringify({ model: 'sonnet', runtime_usage: { input_tokens: 70, output_tokens: 30, total_tokens: 100 } }), now, now);
    recordWorkerCall(db, { consumer: 'checker', role: 'checker', runId: 'r1', goalId: null, loopName: 'doc-drift', runtime: 'claude', meta: { model: 'sonnet', runtime_usage: { input_tokens: 70, output_tokens: 30 } }, durationMs: 2, ok: true });
    const since = new Date(Date.now() - 3_600_000).toISOString(); const until = new Date(Date.now() + 3_600_000).toISOString();
    const { events, mirrors } = usageEvents(db, since, until);
    expect(events.filter((e) => e.source === 'llm_model_calls')).toEqual([]);
    expect(mirrors.map((m) => m.rule)).toEqual(expect.arrayContaining([expect.stringContaining('consumer = checker')]));
    expect(tokenLedger(db, since, until).filter((r) => r.consumer === 'llm:checker')).toEqual([]);
  });
});

describe('executeChecker writes one reviewer ledger row per settled lease', () => {
  let db: Database.Database; let loops: LoopService; let tmp: string;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-ledger-'));
    fs.writeFileSync(path.join(tmp, 'README.md'), '# fixture\n');
    for (const args of [['init'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-m', 'init']]) execFileSync('git', args, { cwd: tmp, stdio: 'ignore' });
    loops = new LoopService(db, fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-ledger-ev-')));
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  async function runReviewer(result: { exitCode: number; stdout: string; stderr: string }) {
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tmp, target_finding: { file_path: 'README.md', description: 'Improve wording', category: 'refactor' } });
    const prepared = loops.continueLoopRun(run.id, { runtime: 'mock', max_assignments: 1, max_maker_workers: 1 });
    const maker = prepared.leases.find((l) => l.role === 'maker')!;
    await loops.executeWorker(run.id, { lease_id: maker.id, timeout_ms: 10_000 });
    loops.runDeterministicChecks(run.id, { lease_id: maker.id, timeout_ms: 10_000, scripts: [] });
    vi.spyOn(loops.runtimeCommand, 'executeRuntimeCommand').mockResolvedValue({ signal: null, timedOut: false, ...result });
    await loops.executeChecker(run.id, { runtime: 'mock', timeout_ms: 10_000 });
    return run.id;
  }

  it('a failed reviewer: one row, ok 0, tokens unknown (NULL)', async () => {
    const runId = await runReviewer({ exitCode: 1, stdout: '', stderr: "remote maker needs model '<host>/<species>', got ''" });
    const rows = ledger(db, 'checker');
    expect(rows).toEqual([expect.objectContaining({ run_id: runId, ok: 0, tokens_in: null, tokens_out: null, purpose: 'checker:doc-drift-and-small-fix-loop' })]);
  });

  it('a reviewer cancelled during execution: its reported tokens are kept on the lease and ledgered once (status cancelled) (Codex #1093)', async () => {
    const run = loops.startDocDriftAndSmallFixLoop({ repository_path: tmp, target_finding: { file_path: 'README.md', description: 'Improve wording', category: 'refactor' } });
    const prepared = loops.continueLoopRun(run.id, { runtime: 'mock', max_assignments: 1, max_maker_workers: 1 });
    const maker = prepared.leases.find((l) => l.role === 'maker')!;
    await loops.executeWorker(run.id, { lease_id: maker.id, timeout_ms: 10_000 });
    loops.runDeterministicChecks(run.id, { lease_id: maker.id, timeout_ms: 10_000, scripts: [] });
    const checkerId = loops.listWorkerLeases(run.id).find((l) => l.role === 'checker')!.id;
    vi.spyOn(loops.runtimeCommand, 'executeRuntimeCommand').mockImplementation(async () => {
      loops.updateWorkerLeaseStatus(checkerId, 'cancelled', { cancellation_reason: 'operator_stop' }); // cancelled while it ran
      return { exitCode: null, signal: 'SIGTERM', timedOut: false, stdout: '{"usage":{"prompt_tokens":70,"completion_tokens":30,"total_tokens":100}}', stderr: '' };
    });
    await loops.executeChecker(run.id, { runtime: 'mock', timeout_ms: 10_000 });
    const lease = loops.getWorkerLease(checkerId);
    expect(lease.status).toBe('cancelled');
    expect(lease.metadata.runtime_usage).toMatchObject({ total_tokens: 100 });
    expect(ledger(db, 'checker')).toEqual([expect.objectContaining({ run_id: run.id, ok: 0, tokens_in: 70, tokens_out: 30, status: 'cancelled' })]);
    // counted once: the lease owns the tokens, the ledger row is its mirror
    const since = new Date(Date.now() - 3_600_000).toISOString(); const until = new Date(Date.now() + 3_600_000).toISOString();
    const { events } = usageEvents(db, since, until);
    expect(events.filter((e) => e.source === 'llm_model_calls' && e.consumer === 'llm:checker')).toEqual([]);
    expect(events.filter((e) => e.source === 'worker_leases' && e.row_id === checkerId).map((e) => e.tokens_reconciled)).toEqual([100]);
  });

  it('an accepted reviewer: one row, ok 1', async () => {
    const runId = await runReviewer({ exitCode: 0, stdout: '{"verdict":"accepted","notes":"fine"}', stderr: '' });
    expect(ledger(db, 'checker')).toEqual([expect.objectContaining({ run_id: runId, ok: 1, purpose: 'checker:doc-drift-and-small-fix-loop' })]);
  });
});

describe('RemoteGymService.record writes one gym ledger row per report', () => {
  const TASK = (commit: string) => ({ commit, source: 'packages/server/src/services/x.ts', tests: ['packages/server/src/__tests__/x.test.ts'], sourceLines: 5 });
  let db: Database.Database; let svc: RemoteGymService;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
    vi.stubEnv('EVOLUTION_GYM_REMOTE_ENABLED', 'true'); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', '/repo');
    svc = new RemoteGymService(db, () => [TASK('c1'), TASK('c2')]);
  });
  afterEach(() => { vi.unstubAllEnvs(); db.close(); });
  const claim = () => (svc.claim('workstation', ['atomic']) as { runId: string }).runId;

  it('reported tokens are recorded; a report without tokens stays NULL; the gym is local', () => {
    const a = claim(); svc.record(a, 'workstation', { status: 'failure', reason: 'tests still red', tokens: 4200, durationMs: 9000 });
    const b = claim(); svc.record(b, 'workstation', { status: 'discarded', reason: 'infra: npm ci failed' });
    const rows = ledger(db, 'gym');
    expect(rows).toEqual([
      // ok = the call ran and was graded (a failed task is a working model call); discarded = infra, not ok
      expect.objectContaining({ run_id: a, ok: 1, tokens_in: 4200, tokens_out: null, provider: 'local', purpose: 'gym:evolution-gym', status: 'failure' }),
      expect.objectContaining({ run_id: b, ok: 0, tokens_in: null, tokens_out: null, status: 'discarded' }),
    ]);
  });
});
