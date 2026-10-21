#!/usr/bin/env node
// SEC-F1 runner (docs/research/eco/SEC-F1_PROTOCOL.md + amendment 1). Offline research harness: no server, no flag, no gate,
// no DB file. For every item, in the registered seeded order:
//   1. shallow-fetch the item's upstream repo at base_sha, `git clone --shared` it, apply the item patch (index untouched);
//   2. build the reviewer prompt with the PROD code from the compiled dist it is pointed at: a real LoopService over an
//      in-memory SQLite DB, writeAssignmentPacket (the item's neutral finding), buildCheckerPrompt with a security_checker
//      lease (which renders the diff with the prod workingTreeDiff). CHECKER_INSTRUCTIONS must hash to the registered
//      value or nothing runs;
//   3. run it with the prod OpenCodeExecutor (`opencode run --format json --dir <checkout> <prompt>`, no --auto, prod env
//      allowlist, prod reviewer timeout, no --model unless SEC_F1_MODEL), minus the nested-spawn env;
//   4. verdict/usage/notes with the prod extractors, notes and stdout redacted with the prod redactSecrets.
// Sequential and resumable (an item with a result.json is skipped). Hard token cap (default 6 M, the sum of opencode step
// totals): no item starts once it is reached, and the running item's OPENCODE_MAX_RUN_TOKENS is lowered to what is left.
// The runner never reads labels (only the blind manifest fields), never npm-installs and never runs a checkout script.
//
// Usage:
//   node scripts/sec-f1-run.mjs --dist <packages/server/dist> --work <dir> --out <results.jsonl>
//        [--items <docs/research/eco/sec-f1>] [--cap 6000000] [--prepare-only] [--only id,id] [--keep-checkouts]
// --prepare-only builds checkouts and prompts (and checks the hash) but calls no model and writes no result line.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ITEMS_DIR, TOKEN_CAP, assertCheckerInstructions, assertSafeOutput, blindItems, parseArgs, prepareCheckout,
  readJsonl, readManifest, readPatch, runOrder, sameChange, sha256, git,
} from './sec-f1-lib.mjs';

export const LOOP_NAME = 'doc-drift-and-small-fix-loop';
/** Protocol: identical, passing deterministic checks for every item, no log body. */
export const FIXED_CHECKS = Object.freeze([
  { name: 'test:changed', status: 'pass', exit_status: 0 },
  { name: 'lint', status: 'pass', exit_status: 0 },
  { name: 'type-check', status: 'pass', exit_status: 0 },
]);
/** Protocol stop: abort when more than 20 % of the first 10 items are no-verdict (harness fault). */
export const EARLY_WINDOW = 10;
export const EARLY_MAX_NO_VERDICT = 2;

const uuidFrom = (s) => { const h = sha256(s); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

/** Run-level stop decisions, pure so the tests can pin them. */
export function capState(results, cap) {
  const used = results.reduce((s, r) => s + (Number(r.tokens_total) || 0), 0);
  return { used, remaining: Math.max(0, cap - used), exhausted: used >= cap };
}
export function earlyAbort(resultsInOrder) {
  const first = resultsInOrder.slice(0, EARLY_WINDOW);
  const noVerdict = first.filter((r) => r.verdict === 'insufficient_evidence').length;
  return noVerdict > EARLY_MAX_NO_VERDICT ? { abort: true, noVerdict, of: first.length } : { abort: false, noVerdict, of: first.length };
}
/** The running item's brake: the prod OPENCODE_MAX_RUN_TOKENS, lowered to the remaining budget. */
export function itemTokenCap(prodCap, remaining) {
  const p = Number(prodCap);
  return Number.isFinite(p) && p > 0 ? Math.min(p, remaining) : remaining;
}

/** The effective model: explicit, else what the runtime reports, else the opencode config default, else null + reason. */
export function effectiveModel(stdout, env = process.env) {
  if (env.SEC_F1_MODEL) return { model: env.SEC_F1_MODEL, source: 'SEC_F1_MODEL' };
  for (const line of String(stdout).split('\n')) {
    if (!line.includes('modelID')) continue;
    try {
      const e = JSON.parse(line); const p = e.part || e;
      const m = p.modelID || p.info?.modelID; const pr = p.providerID || p.info?.providerID;
      if (typeof m === 'string') return { model: pr ? `${pr}/${m}` : m, source: 'runtime_stdout' };
    } catch { /* not an event line */ }
  }
  const fromConfig = (text) => { try { const m = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')).model; return typeof m === 'string' ? m : null; } catch { return null; } };
  if (env.OPENCODE_CONFIG_CONTENT) { const m = fromConfig(env.OPENCODE_CONFIG_CONTENT); if (m) return { model: m, source: 'OPENCODE_CONFIG_CONTENT' }; }
  const files = [env.OPENCODE_CONFIG, env.HOME && path.join(env.HOME, '.config/opencode/opencode.json'), env.HOME && path.join(env.HOME, '.config/opencode/opencode.jsonc')].filter(Boolean);
  for (const f of files) { try { const m = fromConfig(fs.readFileSync(f, 'utf8')); if (m) return { model: m, source: `config:${f}` }; } catch { /* absent */ } }
  return { model: null, source: null, reason: 'not reported by the runtime and no opencode config model: the opencode built-in default applied' };
}

/** The prod code the runner reuses, loaded from the dist it is pointed at (never copied). */
export function loadProd(distDir) {
  const dist = path.resolve(distDir);
  const req = createRequire(path.join(dist, 'index.js'));
  const loop = req(path.join(dist, 'services/loop-service.js'));
  return {
    dist,
    Database: req('better-sqlite3'),
    schema: req(path.join(dist, 'database/schema.js')).schema,
    runMigrations: req(path.join(dist, 'database/migrate.js')).runMigrations,
    LoopService: loop.LoopService,
    CHECKER_INSTRUCTIONS: loop.CHECKER_INSTRUCTIONS,
    OpenCodeExecutor: req(path.join(dist, 'execution/executors/opencode-executor.js')).OpenCodeExecutor,
    daemonReviewerTimeoutMs: req(path.join(dist, 'services/loop-daemon.js')).daemonReviewerTimeoutMs,
    redactSecrets: req(path.join(dist, 'services/secret-patterns.js')).redactSecrets,
  };
}

/** Prompt for one prepared checkout, built by the prod LoopService exactly as the daemon does for a security checker. */
export function buildPrompt(loops, item, checkout) {
  const run = {
    id: uuidFrom(`run|${item.id}`), goal_id: null, loop_name: LOOP_NAME, mode: 'closed', status: 'running',
    repository_path: checkout, state_file: null, findings: [item.finding], plan: {}, gates: [], next_actions: [], metadata: {},
    created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z', completed_at: null,
  };
  loops.ensureWorktreeControlIgnore(checkout); // prod: the .djimitflo/ control dir is excluded, never part of the diff
  const packet = loops.writeAssignmentPacket(checkout, run, item.finding, 'opencode');
  const lease = (id, role, extra) => ({ id, loop_run_id: run.id, role, runtime: 'opencode', status: 'running', finding_id: item.finding.id,
    branch_name: null, budget: {}, created_at: run.created_at, updated_at: run.updated_at, ...extra });
  const maker = lease(uuidFrom(`maker|${item.id}`), 'maker', { worktree_path: checkout, metadata: { assignment_packet_file: packet, deterministic_checks: FIXED_CHECKS.map((c) => ({ ...c })) } });
  const checker = lease(uuidFrom(`security|${item.id}`), 'security_checker', { worktree_path: checkout, metadata: {} });
  const prompt = loops.buildCheckerPrompt(run, maker, checker);
  const diff = loops.workingTreeDiff(checkout);
  return { prompt, diff, packet };
}

/** One reviewer run through the prod OpenCodeExecutor and the prod result mapping. */
export async function review(prod, loops, prompt, checkout, timeoutMs) {
  const executor = new prod.OpenCodeExecutor();
  const task = { id: `sec-f1-${sha256(prompt).slice(0, 12)}`, title: 'security_checker worker', description: prompt, metadata: {} };
  const options = { workingDirectory: checkout, timeout: timeoutMs, skipPermissions: false, ...(process.env.SEC_F1_MODEL ? { model: process.env.SEC_F1_MODEL } : {}) };
  const { args } = executor.buildCommand(task, options);
  if (args.includes('--auto')) throw new Error('SEC_F1_AUTO_FLAG'); // prod reviewers run with skipPermissions=false
  const session = await executor.start(task, options);
  const events = session.events[Symbol.asyncIterator](); // draining the stream drives the process; events are not persisted
  while (!(await events.next()).done) { /* drain */ }
  const completed = await session.result;
  return { result: loops.workerExecutor.toRuntimeResult(completed), args: args.slice(0, -1) };
}

async function main(argv) {
  const o = parseArgs(argv, { dist: 'v', work: 'v', out: 'v', items: 'v', cap: 'v', only: 'v', 'prepare-only': 'flag', 'keep-checkouts': 'flag' });
  if (!o.dist || !o.work || (!o.out && !o['prepare-only'])) throw new Error('usage: sec-f1-run.mjs --dist <server dist> --work <dir> --out <results.jsonl> [--prepare-only]');
  const itemsDir = path.resolve(o.items || DEFAULT_ITEMS_DIR);
  const work = assertSafeOutput(o.work, { itemsDir });
  const out = o.out ? assertSafeOutput(o.out, { itemsDir }) : null;
  const cap = o.cap ? Number(o.cap) : TOKEN_CAP;
  if (!Number.isFinite(cap) || cap <= 0 || cap > TOKEN_CAP) throw new Error(`--cap must be in (0, ${TOKEN_CAP}]`);

  // the reviewer must not reach the control plane, and nothing here may open the prod DB
  for (const k of ['DJIMITFLO_CONTROL_URL', 'DJIMITFLO_SPAWN_TOKEN', 'DB_PATH']) delete process.env[k];
  process.env.LOOP_EVIDENCE_ROOT = path.join(work, 'evidence');
  const prod = loadProd(o.dist);
  const instructionsSha = assertCheckerInstructions(prod.CHECKER_INSTRUCTIONS); // abort before the first item
  const db = new prod.Database(':memory:');
  db.exec(prod.schema); prod.runMigrations(db);
  const loops = new prod.LoopService(db, path.join(work, 'evidence'));
  const timeoutMs = Math.max(1_000, Math.min(prod.daemonReviewerTimeoutMs() || 120_000, 600_000)); // prod executeChecker clamp
  const prodCap = process.env.OPENCODE_MAX_RUN_TOKENS;

  const items = blindItems(readManifest(itemsDir));
  const byId = new Map(items.map((i) => [i.id, i]));
  let order = runOrder(items.map((i) => i.id));
  if (o.only) { const only = new Set(o.only.split(',')); order = order.filter((id) => only.has(id)); }
  const resultsDir = out ? `${out}.d` : path.join(work, 'prepared');
  fs.mkdirSync(resultsDir, { recursive: true });
  let opencodeVersion = null;
  try { opencodeVersion = execFileSync(process.env.OPENCODE_BIN_PATH || 'opencode', ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim(); } catch { /* recorded as null */ }
  fs.writeFileSync(path.join(resultsDir, 'run-meta.json'), `${JSON.stringify({
    protocol: 'SEC-F1 amendment 1', dist: prod.dist, checker_instructions_sha256: instructionsSha, order, cap, timeout_ms: timeoutMs,
    prod_opencode_max_run_tokens: prodCap ?? null, requested_model: process.env.SEC_F1_MODEL || null, opencode_version: opencodeVersion,
    node: process.version, started_at: new Date().toISOString(), prepare_only: Boolean(o['prepare-only']),
  }, null, 2)}\n`);

  // resume: a result.json is authoritative; the JSONL is rebuilt from them so a crash between the two cannot lose a line
  const done = () => order.map((id) => path.join(resultsDir, id, 'result.json')).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const syncJsonl = () => { if (!out) return; const have = new Set(readJsonl(out).map((r) => r.id)); for (const r of done()) if (!have.has(r.id)) fs.appendFileSync(out, `${JSON.stringify(r)}\n`); };
  syncJsonl();

  for (const [index, id] of order.entries()) {
    const item = byId.get(id);
    const itemDir = path.join(resultsDir, id);
    if (fs.existsSync(path.join(itemDir, 'result.json'))) continue;
    const early = earlyAbort(done().sort((a, b) => a.order_index - b.order_index));
    if (early.abort) { console.error(JSON.stringify({ stop: 'early_no_verdict', ...early })); process.exitCode = 4; break; }
    const state = capState(done(), cap);
    if (!o['prepare-only'] && state.exhausted) { console.error(JSON.stringify({ stop: 'token_cap', used: state.used, cap })); break; }
    const patch = readPatch(itemsDir, item);
    const checkout = prepareCheckout(work, item, patch);
    const { prompt, diff } = buildPrompt(loops, item, checkout);
    if (!sameChange(diff, patch)) throw new Error(`SEC_F1_DIFF_MISMATCH ${id}: the rendered working-tree diff is not the registered patch`);
    fs.mkdirSync(itemDir, { recursive: true });
    fs.writeFileSync(path.join(itemDir, 'prompt.md'), prompt);
    const base = { schema: 'sec-f1-result/1', id, order_index: index, repo: item.repo, base_sha: item.base_sha, patch_sha256: item.patch_sha256,
      diff_sha256: sha256(diff), prompt_sha256: sha256(prompt), checker_instructions_sha256: instructionsSha };
    if (o['prepare-only']) {
      console.log(JSON.stringify({ prepared: id, prompt_chars: prompt.length, diff_sha256: base.diff_sha256 }));
      if (!o['keep-checkouts']) fs.rmSync(checkout, { recursive: true, force: true });
      continue;
    }
    const maxRun = itemTokenCap(prodCap, state.remaining);
    process.env.OPENCODE_MAX_RUN_TOKENS = String(maxRun);
    const statusBefore = git(['-C', checkout, 'status', '--porcelain=v1', '--untracked-files=all']);
    const startedAt = new Date();
    const { result, args } = await review(prod, loops, prompt, checkout, timeoutMs);
    const stdout = result.stdout || '';
    const ok = result.exitCode === 0 && !result.timedOut;
    const verdict = ok ? loops.extractCheckerVerdict(stdout) : 'insufficient_evidence';
    const usage = loops.extractRuntimeUsage(stdout);
    const model = effectiveModel(stdout);
    const statusAfter = git(['-C', checkout, 'status', '--porcelain=v1', '--untracked-files=all']);
    fs.writeFileSync(path.join(itemDir, 'stdout.redacted.jsonl'), prod.redactSecrets(stdout).redacted);
    const record = {
      ...base, started_at: startedAt.toISOString(), finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt.getTime(),
      runtime: 'opencode', args, timeout_ms: timeoutMs, max_run_tokens_applied: maxRun,
      requested_model: process.env.SEC_F1_MODEL || null, effective_model: model.model, effective_model_source: model.source, ...(model.reason ? { effective_model_reason: model.reason } : {}),
      exit_code: result.exitCode, timed_out: result.timedOut, verdict, verdict_parsed: ok && loops.checkerVerdictParsed(stdout),
      notes_redacted: prod.redactSecrets(loops.extractCheckerNotes(stdout) || '').redacted.slice(0, 4_000),
      usage: usage || { usage_source: 'unknown' }, tokens_total: usage?.total_tokens ?? 0,
      reviewer_changed_worktree: statusAfter !== statusBefore,
      stderr_tail_redacted: prod.redactSecrets((result.stderr || '').slice(-2_000)).redacted,
    };
    fs.writeFileSync(path.join(itemDir, 'result.json'), `${JSON.stringify(record, null, 2)}\n`);
    syncJsonl();
    console.log(JSON.stringify({ id, index, verdict, tokens: record.tokens_total, used: state.used + record.tokens_total }));
    if (!o['keep-checkouts']) fs.rmSync(checkout, { recursive: true, force: true });
  }
  db.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(/HASH_MISMATCH/.test(String(err?.message)) ? 3 : 1); });
}
