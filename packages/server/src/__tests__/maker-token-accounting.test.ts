import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import * as accounting from '../services/maker-token-accounting';

const { failAccounting } = vi.hoisted(() => ({ failAccounting: { on: false } }));
vi.mock('../services/maker-token-accounting', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/maker-token-accounting')>();
  return { ...real, computeTokenAccounting: (input: Parameters<typeof real.computeTokenAccounting>[0]) => {
    if (failAccounting.on) throw new Error('boom');
    return real.computeTokenAccounting(input);
  } };
});
const { computeTokenAccounting, readTokenAccounting, makerTokenAccountingEvidence } = accounting;

/**
 * P0 §5: maker leases carry token accounting — only what the runtime reports, measured vs estimated, never fabricated;
 * an accounting failure never changes the lease outcome; old leases read as unrecorded.
 */
const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  failAccounting.on = false;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const freshDb = () => { const d = new Database(':memory:'); d.exec(schema); runMigrations(d); dbs.push(d); return d; };
const priceVersion = (entry: string) => createHash('sha256').update(entry).digest('hex').slice(0, 16);

const step = (tokens: Record<string, unknown>) => JSON.stringify({ type: 'step_finish', sessionID: 's', part: { type: 'step-finish', reason: 'stop', tokens, id: 'p', messageID: 'm', sessionID: 's' } });
const OPENCODE_STDOUT = [
  JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
  step({ total: 1500, input: 1000, output: 400, reasoning: 100, cache: { read: 200, write: 0 } }),
  'plain log line',
  step({ total: 2600, input: 2000, output: 500, reasoning: 100, cache: { read: 300, write: 0 } }),
].join('\n');

function loopFixture(runtime: string, model?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-mta-')); roots.push(root);
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'Small documentation fixture\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: repo, stdio: 'ignore' });
  const db = freshDb();
  const loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES ('mt-run','doc-drift-and-small-fix-loop','closed','running',?,?,?)`).run(repo,
    JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Improve wording', evidence: 'Small text', suggested_fix: 'Clarify wording' }]),
    JSON.stringify({ risk_class: 'low' }));
  const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
  loops.insertWorkerLease({ id: 'maker', loopRunId: 'mt-run', role: 'maker', runtime, findingId: 'finding', worktreePath: repo, branchName: null, now: new Date().toISOString(),
    metadata: { assignment_file: assignment, ...(model ? { model } : {}) } });
  return { db, loops };
}

async function runMaker(runtime: string, model: string | undefined, stdout: string) {
  const { db, loops } = loopFixture(runtime, model);
  vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>);
  vi.spyOn(loops.workerExecutor as unknown as { executeViaEngine: () => Promise<unknown> }, 'executeViaEngine')
    .mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout, stderr: '' });
  const result = await loops.executeMaker('mt-run', { lease_id: 'maker' });
  return { db, loops, result, lease: loops.getWorkerLease('maker') };
}

/** Two maker leases of runtime 'custom' (generic usage object) in a fresh db. */
function leaseTable() {
  const db = freshDb();
  db.prepare("INSERT INTO loop_runs (id, loop_name, mode, status) VALUES ('r', 'x', 'closed', 'running')").run();
  const ins = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at) VALUES (?, 'r', 'maker', 'custom', 'completed', ?, ?)");
  const add = (id: string, a: accounting.MakerTokenAccounting) => ins.run(id, JSON.stringify({ token_accounting: a }), new Date().toISOString());
  const custom = (usage: Record<string, number>) => computeTokenAccounting({ runtime: 'custom', stdout: JSON.stringify({ usage }), leaseMetadata: { model: 'm' }, durationMs: 1 });
  const group = () => makerTokenAccountingEvidence(db, new Date(Date.now() - 86_400_000).toISOString()).by_runtime_model[0];
  return { add, custom, group };
}

describe('maker lease token accounting', () => {
  it('opencode lease records provider-reported totals summed over steps', async () => {
    vi.stubEnv('LLM_PRICE_PER_MTOK', 'qwen3=1/2');
    const { lease } = await runMaker('opencode', 'ollama/qwen3', OPENCODE_STDOUT);
    expect(lease.metadata.token_accounting).toMatchObject({
      runtime: 'opencode', model_id: 'ollama/qwen3', model_source: 'lease_config', provider: 'ollama',
      input_tokens: 3000, output_tokens: 900, cache_read_tokens: 500, cache_write_tokens: 0, reasoning_tokens: 200, total_tokens: 4100,
      measurement_source: 'provider_reported', completeness: 'complete', retry_count: 0, reason: null,
    });
    const a = lease.metadata.token_accounting as accounting.MakerTokenAccounting;
    expect(a.duration_ms).toEqual(expect.any(Number));
    // no price for the full id 'ollama/qwen3' (prices name the model): cost stays null with the reason
    expect(a.estimated_cost_usd).toBeNull();
    expect(a.cost_reason).toMatch(/no LLM_PRICE_PER_MTOK price/);
  });

  it('cost is an estimate only with a known price, and carries its price provenance', () => {
    const out = (env: string | undefined, stdout = OPENCODE_STDOUT) => {
      if (env) vi.stubEnv('LLM_PRICE_PER_MTOK', env);
      return computeTokenAccounting({ runtime: 'opencode', stdout, leaseMetadata: { model: 'ollama/qwen3' }, durationMs: 10 });
    };
    expect(out(undefined)).toMatchObject({ estimated_cost_usd: null, cost_completeness: null, price_version: null, price_source: null, price_input_per_mtok: null });
    // cache reads present (500) but no cache price: input/output priced, cost partial with the reason — never silently omitted
    expect(out('other=9/9,ollama/qwen3=1/2')).toMatchObject({ estimated_cost_usd: 0.0048, cost_completeness: 'partial', cost_reason: 'cache tokens not priced',
      price_input_per_mtok: 1, price_output_per_mtok: 2, price_cache_read_per_mtok: null, price_cache_write_per_mtok: null,
      price_source: 'LLM_PRICE_PER_MTOK', price_version: priceVersion('ollama/qwen3=1/2') });
    // with a cache-read price (in/out/cache_read/cache_write): complete; 500 cache reads × 0.1 added
    expect(out('ollama/qwen3=1/2/0.1')).toMatchObject({ estimated_cost_usd: 0.00485, cost_completeness: 'complete', cost_reason: null, price_cache_read_per_mtok: 0.1 });
    // no cache tokens at all: the in/out price is the complete cost
    expect(out('ollama/qwen3=1/2', step({ total: 30, input: 10, output: 20, cache: { read: 0, write: 0 } }))).toMatchObject({ cost_completeness: 'complete', cost_reason: null });
  });

  it('remote lease records unavailable — the host reports no tokens, none are invented', async () => {
    const { lease, result } = await runMaker('remote', 'workstation/atomic@llama-router', 'remote maker (workstation): patch applied');
    expect(lease.metadata.token_accounting).toMatchObject({ runtime: 'remote', measurement_source: 'unavailable', completeness: 'none',
      input_tokens: null, output_tokens: null, total_tokens: null, estimated_cost_usd: null, model_id: 'workstation/atomic@llama-router' });
    expect(String((lease.metadata.token_accounting as accounting.MakerTokenAccounting).reason)).toMatch(/remote host/);
    // even a usage-looking line in the remote output is not trusted as a token count
    expect(computeTokenAccounting({ runtime: 'remote', stdout: '{"usage":{"total_tokens":99}}', leaseMetadata: {}, durationMs: 1 }).total_tokens).toBeNull();
    expect(result.lease.status).toBe(lease.status);
  });

  it('cache reads and writes are separate fields per runtime; atomic is unavailable', () => {
    // opencode: cache.read / cache.write as reported
    expect(computeTokenAccounting({ runtime: 'opencode', durationMs: 1, leaseMetadata: {}, stdout: step({ total: 60, input: 10, output: 20, cache: { read: 25, write: 5 } }) }))
      .toMatchObject({ input_tokens: 10, cache_read_tokens: 25, cache_write_tokens: 5, total_tokens: 60 });
    // codex: input_tokens includes cached_input_tokens → uncached input = 100 - 40; codex reports no cache writes (null)
    const codex = computeTokenAccounting({ runtime: 'codex', durationMs: 1, leaseMetadata: { model: 'gpt-5.1-codex', retry_attempt: 2 },
      stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 } }) });
    expect(codex).toMatchObject({ provider: 'openai', input_tokens: 60, cache_read_tokens: 40, cache_write_tokens: null, output_tokens: 20, reasoning_tokens: 5, total_tokens: 120,
      measurement_source: 'provider_reported', completeness: 'complete', retry_count: 2 });
    // claude: cache_read_input_tokens / cache_creation_input_tokens, both outside input_tokens
    const claudeOut = JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, modelUsage: { 'claude-x': {} } });
    expect(computeTokenAccounting({ runtime: 'claude', durationMs: 1, leaseMetadata: {}, stdout: claudeOut })).toMatchObject({ provider: 'anthropic', model_id: 'claude-x',
      model_source: 'runtime_reported', input_tokens: 10, cache_read_tokens: 7, cache_write_tokens: 3, total_tokens: 25, reasoning_tokens: null, completeness: 'complete' });
    // cache reads priced, cache writes not: still partial
    vi.stubEnv('LLM_PRICE_PER_MTOK', 'claude-x=1/1/0.1');
    expect(computeTokenAccounting({ runtime: 'claude', durationMs: 1, leaseMetadata: {}, stdout: claudeOut })).toMatchObject({ cost_completeness: 'partial', cost_reason: 'cache tokens not priced' });
    vi.stubEnv('LLM_PRICE_PER_MTOK', 'claude-x=1/1/0.1/1.25');
    expect(computeTokenAccounting({ runtime: 'claude', durationMs: 1, leaseMetadata: {}, stdout: claudeOut })).toMatchObject({ cost_completeness: 'complete', estimated_cost_usd: 0.000019 });
    expect(computeTokenAccounting({ runtime: 'atomic', stdout: 'answer', leaseMetadata: {}, durationMs: 1 })).toMatchObject({ measurement_source: 'unavailable', completeness: 'none' });
    // opencode step totals without the in/out split: partial, never a fabricated split
    expect(computeTokenAccounting({ runtime: 'opencode', stdout: step({ total: 50 }), leaseMetadata: {}, durationMs: 1 }))
      .toMatchObject({ total_tokens: 50, input_tokens: null, output_tokens: null, completeness: 'partial', cost_reason: 'model unknown' });
  });

  it('an accounting throw does not change the lease status or outcome', async () => {
    const ok = await runMaker('opencode', 'ollama/qwen3', OPENCODE_STDOUT);
    failAccounting.on = true;
    const broken = await runMaker('opencode', 'ollama/qwen3', OPENCODE_STDOUT);
    expect(broken.lease.status).toBe(ok.lease.status);
    expect(broken.result.run.status).toBe(ok.result.run.status);
    expect(broken.result.gates.map((g) => [g.name, g.status])).toEqual(ok.result.gates.map((g) => [g.name, g.status]));
    expect(broken.lease.metadata.token_accounting).toMatchObject({ completeness: 'none', measurement_source: 'unavailable', total_tokens: null,
      reason: 'accounting_error: boom' });
  });

  it('an old lease without the field reads as unrecorded', () => {
    expect(readTokenAccounting({ runtime_usage: { usage_source: 'unknown' } })).toEqual({ status: 'unrecorded' });
    expect(readTokenAccounting(undefined)).toEqual({ status: 'unrecorded' });
  });

  it('aggregates per runtime × model: leases, measured-token share, known-cost share', async () => {
    vi.stubEnv('LLM_PRICE_PER_MTOK', 'ollama/qwen3=1/2/0.1');
    const { db } = await runMaker('opencode', 'ollama/qwen3', OPENCODE_STDOUT);
    const now = new Date().toISOString();
    const ins = db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at) VALUES (?, 'mt-run', 'maker', ?, 'completed', ?, ?)");
    ins.run('old', 'opencode', JSON.stringify({ model: 'ollama/qwen3' }), now); // pre-accounting lease
    ins.run('remote-1', 'remote', JSON.stringify({ token_accounting: computeTokenAccounting({ runtime: 'remote', stdout: '', leaseMetadata: { model: 'ws/atomic' }, durationMs: 5 }) }), now);
    ins.run('checker-ignored', 'opencode', '{}', now);
    db.prepare("UPDATE worker_leases SET role = 'checker' WHERE id = 'checker-ignored'").run();
    const ev = makerTokenAccountingEvidence(db, new Date(Date.now() - 86_400_000).toISOString());
    expect(ev.leases).toBe(3);
    expect(ev.by_runtime_model).toEqual([
      expect.objectContaining({ runtime: 'opencode', model: 'ollama/qwen3', leases: 2, unrecorded: 1, tokens_measured: 1, tokens_measured_share: 0.5,
        cost_known: 1, cost_known_share: 0.5, cost_partial: 0 }),
      expect.objectContaining({ runtime: 'remote', model: 'ws/atomic', leases: 1, unrecorded: 0, tokens_measured: 0, tokens_measured_share: 0, cost_known: 0,
        by_source: { provider_reported: 0, runtime_log: 0, estimated: 0, unavailable: 1 } }),
    ]);
    const oc = ev.by_runtime_model[0];
    expect(oc.fields.total_tokens).toEqual({ n: 1, sum: 4100, mean: 4100 });
    expect(oc.fields.cache_read_tokens).toEqual({ n: 1, sum: 500, mean: 500 });
    expect(oc.cost_by_price_version).toEqual([{ price_version: priceVersion('ollama/qwen3=1/2/0.1'), leases: 1, partial: 0, estimated_cost_usd: 0.00485 }]);
    expect(buildEvolutionEvidence(db).maker_tokens.leases).toBe(3);
    expect(makerTokenAccountingEvidence(new Database(':memory:'), now)).toMatchObject({ leases: 0, by_runtime_model: [] }); // no table: fail-soft
  });

  it('a partial lease (input only) adds nothing to fields it did not report and never lowers their averages', () => {
    const { add, custom, group } = leaseTable();
    const partial = custom({ input_tokens: 300 });
    expect(partial).toMatchObject({ completeness: 'partial', input_tokens: 300, output_tokens: null, total_tokens: null });
    add('a', custom({ input_tokens: 100, output_tokens: 50 }));
    add('b', partial);
    const g = group();
    expect(g.tokens_measured).toBe(2);
    expect(g.fields.total_tokens).toEqual({ n: 1, sum: 150, mean: 150 }); // not (150 + 0) / 2
    expect(g.fields.output_tokens).toEqual({ n: 1, sum: 50, mean: 50 });
    expect(g.fields.input_tokens).toEqual({ n: 2, sum: 400, mean: 200 });
    expect(g.fields.cache_write_tokens).toEqual({ n: 0, sum: null, mean: null });
  });

  it('costs under different price versions are reported per version, never summed together', () => {
    const { add, custom, group } = leaseTable();
    vi.stubEnv('LLM_PRICE_PER_MTOK', 'm=1/1');
    add('a', custom({ input_tokens: 1_000_000, output_tokens: 0 }));
    vi.stubEnv('LLM_PRICE_PER_MTOK', 'm=3/1');
    add('b', custom({ input_tokens: 1_000_000, output_tokens: 0 }));
    const g = group();
    expect(g.cost_known).toBe(2);
    expect(g.cost_by_price_version).toEqual([
      { price_version: priceVersion('m=1/1'), leases: 1, partial: 0, estimated_cost_usd: 1 },
      { price_version: priceVersion('m=3/1'), leases: 1, partial: 0, estimated_cost_usd: 3 },
    ].sort((x, y) => x.price_version.localeCompare(y.price_version)));
    expect(g).not.toHaveProperty('estimated_cost_usd_known');
  });
});
