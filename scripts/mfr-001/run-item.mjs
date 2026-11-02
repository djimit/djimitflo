#!/usr/bin/env node
// MFR-001 item runner, WORKSTATION ONLY (protocol "Procedure per item"). One item, both arms, one at a time:
//   nice -n 10 node run-item.mjs <item.json> <result.json>
// Rebuilds the item at its base commit in a throwaway worktree of its own clone (~/mfr-001/repo, never the gym worker's
// repo), runs npm / vitest / atomic-agent in the gym runner image (djimitflo-gym-runner) against the local llama-router
// (0 cloud tokens), and writes one result JSON. Never talks to the VPS. Containers carry their own label
// (djimitflo-gym-host=mfr-001), so the gym worker's orphan sweep and this runner never touch each other's containers.
// Exit codes: 0 done (any outcome), 3 held-out leak (abort the experiment), 1 harness error.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAKER_MAX_STEPS, MAKER_TIMEOUT_MS, applyDescriptor, armOrder, assertDisjoint, assertNoLeak, buildPrompt, changedFrom, classify, heldScore, sha256 } from './lib.mjs';

const env = process.env;
const WORK = (env.MFR_WORK || path.join(os.homedir(), 'mfr-001')).replace(/^~/, os.homedir());
const IMAGE = env.MFR_RUNNER_IMAGE || 'djimitflo-gym-runner:atomic-0.6.5';
const LLAMA = env.MFR_LLAMA_URL || 'http://127.0.0.1:8084';
const NPM_VOLUME = 'mfr-001-npm';
const LABEL = 'djimitflo-gym-host=mfr-001';
const VITEST_TIMEOUT_MS = 180_000;
const ATOMIC_CONFIG = JSON.stringify({ version: 72, localModels: { url: LLAMA, mode: 'external' }, llm: { activeTextProvider: 'local-llama', activeEmbeddingProvider: 'local-llama', toolTransport: 'auto', providers: [{ id: 'local-llama', kind: 'llama-server', url: LLAMA }] } });

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts });
const git = (cwd, args) => sh('git', ['-C', cwd, ...args]);
let seq = 0;
/** One runner container, niced, CPU-capped, named and labelled so a timeout can remove it. */
function inRunner(wt, cmd, { input, timeoutMs = 900_000, extra = [] } = {}) {
  const name = `mfr-001-${process.pid}-${seq++}`;
  const args = ['run', '--rm', '-i', '--name', name, '--label', LABEL, '--cpus', env.MFR_CPUS || '8', '--network', 'host', '-v', `${wt}:/w`, '-v', `${NPM_VOLUME}:/root/.npm`, '-w', '/w', ...extra, IMAGE, 'nice', '-n', '10', 'sh', '-c', cmd];
  const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 });
  if (r.error || r.signal) spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 60_000 });
  return r;
}
const termination = (r) => (r.error?.code === 'ETIMEDOUT' || r.signal ? 'timeout' : r.error ? 'error' : `exit:${r.status}`);

// runs inside the container: each variant of the target in turn, one vitest run of the test file each, target restored
const VARIANT_RUNNER = `const fs=require('fs');const {spawnSync}=require('child_process');
const v=JSON.parse(fs.readFileSync('/w/.djimitflo/variants.json','utf8'));const file='/w/'+v.target;const orig=fs.readFileSync(file,'utf8');const out=[];
try{for(const x of v.variants){fs.writeFileSync(file,x.content===null?orig:x.content);
const r=spawnSync('npx',['vitest','run',v.test],{cwd:'/w/packages/server',timeout:v.timeout,stdio:'ignore'});
out.push({name:x.name,result:r.error||r.signal?'timeout':r.status===0?'pass':'fail'});}}finally{fs.writeFileSync(file,orig);}
fs.writeFileSync('/w/.djimitflo/variants-out.json',JSON.stringify(out));`;

/** Runs the test file against the real target and each named mutant; the variant files are removed afterwards. */
function runVariants(wt, item, variants) {
  const dir = path.join(wt, '.djimitflo'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'variants.json'), JSON.stringify({ target: item.target, test: item.test.replace(/^packages\/server\//, ''), timeout: VITEST_TIMEOUT_MS, variants }));
  fs.writeFileSync(path.join(dir, 'variant-runner.cjs'), VARIANT_RUNNER);
  try {
    const r = inRunner(wt, 'node /w/.djimitflo/variant-runner.cjs', { timeoutMs: VITEST_TIMEOUT_MS * (variants.length + 1) });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'variants-out.json'), 'utf8'));
    if (r.status !== 0 || out.length !== variants.length) throw new Error(`variant runner exit ${r.status}`);
    return Object.fromEntries(out.map((o) => [o.name, o.result]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function routerModels() {
  try {
    const r = await fetch(`${LLAMA.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const data = (await r.json())?.data ?? [];
    return data.map((m) => `${m.id}${m.status?.value ? `:${m.status.value}` : ''}`).join(',').slice(0, 200) || null;
  } catch { return null; }
}

/** The worktree must hold exactly the original test and the real target, and nothing of the oracle. */
function assertPristine(wt, item, original) {
  if (fs.existsSync(path.join(wt, '.djimitflo'))) throw new Error('pristine: .djimitflo present before a maker run');
  if (sha256(fs.readFileSync(path.join(wt, item.target), 'utf8')) !== sha256(original)) throw new Error('pristine: target differs from base');
  if (sha256(fs.readFileSync(path.join(wt, item.test), 'utf8')) !== item.original_test_sha256) throw new Error('pristine: test differs from the original');
  const dirty = changedFrom(git(wt, ['diff', '--name-only', 'HEAD']), git(wt, ['ls-files', '--others', '--exclude-standard']));
  if (dirty.length) throw new Error(`pristine: worktree dirty (${dirty.join(', ')})`);
}

export async function runItem(item) {
  const t0 = Date.now(); const timings = {};
  const res = { id: item.id, eligible: false, exclusion: null, arm_order: armOrder(item.id), runs: {}, timings, host: os.hostname(), image: IMAGE, started_at: new Date(t0).toISOString() };
  fs.mkdirSync(WORK, { recursive: true });
  const repo = path.join(WORK, 'repo');
  if (!fs.existsSync(repo)) sh('git', ['clone', '-q', 'https://github.com/djimit/djimitflo.git', repo]);
  try { git(repo, ['cat-file', '-e', `${item.base}^{commit}`]); } catch { git(repo, ['fetch', '-q', 'origin', item.base]); }
  const wt = fs.mkdtempSync(path.join(WORK, 'wt-')); const states = [];
  try {
    git(repo, ['worktree', 'add', '-q', '--detach', wt, item.base]);
    const original = fs.readFileSync(path.join(wt, item.target), 'utf8');
    if (sha256(original) !== item.target_sha256) throw new Error('target at base differs from the manifest');
    const content = (d) => { const c = applyDescriptor(original, d); if (c === null || sha256(c) !== d.sha256) throw new Error(`mutant ${d.key} does not rebuild`); return c; };
    const { prod, shown, held_out: held } = item.mutants;
    assertDisjoint(shown.map((d) => ({ ...d, content: content(d) })), held.map((d) => ({ ...d, content: content(d) })), prod.map((d) => ({ ...d, content: content(d) })));
    fs.mkdirSync(path.dirname(path.join(wt, item.test)), { recursive: true });
    fs.writeFileSync(path.join(wt, item.test), item.original_test);
    git(wt, ['add', '--', item.test]);
    git(wt, ['-c', 'user.email=mfr-001@djimitflo', '-c', 'user.name=mfr-001', 'commit', '-q', '--allow-empty', '-m', `mfr-001: original test of lease ${item.id}`]);
    let t = Date.now();
    // as production's test:changed: install, then build the workspace packages the server imports (shared, agent-catalog)
    const ci = inRunner(wt, '(npm ci --legacy-peer-deps --no-audit --no-fund && npm run build -w @djimitflo/shared && npm run build -w @djimitflo/agent-catalog) > /tmp/ci.log 2>&1; rc=$?; tail -15 /tmp/ci.log; exit $rc', { timeoutMs: 1_200_000 });
    timings.npm_ci_ms = Date.now() - t;
    if (ci.status !== 0) { res.exclusion = 'infra'; res.infra_error = `npm ci failed: ${(ci.stdout || ci.stderr || '').slice(-300)}`; return res; }
    // pre-treatment: the original test on the real target and on every mutant (diagnostic fidelity vs prod, shown survivors)
    t = Date.now();
    const v = runVariants(wt, item, [{ name: 'base', content: null }, ...[...prod, ...shown, ...held].map((d) => ({ name: d.key, content: content(d) }))]);
    timings.original_scoring_ms = Date.now() - t;
    const killed = (ds) => ds.filter((d) => v[d.key] !== 'pass').map((d) => d.key);
    res.original = { baseline: v.base, prod_killed: killed(prod).length, prod_killed_in_prod: item.prod_graded.killed, fidelity_match: killed(prod).length === item.prod_graded.killed, shown_killed: killed(shown), held_killed: killed(held), held_kill: killed(held).length / held.length };
    if (v.base !== 'pass') { res.exclusion = 'original_test_red_at_base'; return res; }
    const survivors = shown.filter((d) => v[d.key] === 'pass');
    res.survivors_shown = survivors.map((d) => d.key);
    if (!survivors.length) { res.exclusion = 'no_shown_survivor'; return res; }
    res.eligible = true; res.router_models = await routerModels();
    for (const [index, arm] of res.arm_order.entries()) {
      const run = { order_index: index };
      // every arm starts from the same pristine state: original test committed, target real, no oracle files
      git(wt, ['checkout', '-q', '--', '.']); git(wt, ['clean', '-fdq']); fs.rmSync(path.join(wt, '.djimitflo'), { recursive: true, force: true });
      assertPristine(wt, item, original);
      const prompt = buildPrompt({ test: item.test, target: item.target, arm, survivors: arm === 'feedback' ? survivors : [] });
      const input = `${prompt}\n`;
      assertNoLeak(input, held, { target: item.target, shown: survivors }); // throws MFR_LEAK: abort
      Object.assign(run, { prompt_sha256: sha256(prompt), prompt_chars: prompt.length, shown_in_prompt: arm === 'feedback' ? survivors.length : 0, leak_check: 'pass', prompt });
      const state = fs.mkdtempSync(path.join(WORK, 'state-')); states.push(state);
      const stateArgs = ['-v', `${state}:/state`, '-e', 'ATOMIC_AGENT_STATE_DIR=/state'];
      if (inRunner(wt, `atomic-agent config set '${ATOMIC_CONFIG}' >/dev/null`, { extra: stateArgs, timeoutMs: 60_000 }).status !== 0) { run.class = 'infra'; run.infra_error = 'atomic config failed'; res.runs[arm] = run; continue; }
      t = Date.now();
      const m = inRunner(wt, `atomic-agent run --cwd /w --max-steps ${MAKER_MAX_STEPS} --no-approval`, { input, extra: stateArgs, timeoutMs: MAKER_TIMEOUT_MS });
      run.maker_ms = Date.now() - t; run.termination = termination(m);
      run.changed = changedFrom(git(wt, ['diff', '--name-only', 'HEAD']), git(wt, ['ls-files', '--others', '--exclude-standard']));
      const scoped = run.changed.length > 0 && run.changed.every((f) => f === item.test);
      if (scoped) {
        // the target is never the maker's: always score against the real one
        fs.writeFileSync(path.join(wt, item.target), original);
        const retried = fs.readFileSync(path.join(wt, item.test), 'utf8');
        run.retried_test_sha256 = sha256(retried);
        run.retried_test_diff = git(wt, ['diff', 'HEAD', '--', item.test]).slice(0, 50_000);
        t = Date.now();
        try {
          const rv = runVariants(wt, item, [{ name: 'base', content: null }, ...[...held, ...shown].map((d) => ({ name: d.key, content: content(d) }))]);
          run.baseline = rv.base; run.held_runs = held.map((d) => rv[d.key]); run.shown_runs = shown.map((d) => rv[d.key]);
        } catch (err) { run.class = 'infra'; run.infra_error = `scoring: ${String(err?.message ?? err).slice(0, 150)}`; }
        run.scoring_ms = Date.now() - t;
      }
      if (!run.class) run.class = classify({ termination: run.termination, changed: run.changed, test: item.test, baseline: run.baseline ?? null });
      run.held_score = run.class === 'infra' ? null : heldScore(run.class, run.held_runs);
      run.shown_kill = run.class === 'ok' ? run.shown_runs.filter((r) => r !== 'pass').length / shown.length : 0;
      res.runs[arm] = run;
      console.log(`${item.id.slice(0, 8)} run ${index}: ${run.class} (${Math.round(run.maker_ms / 1000)} s maker)`); // arm label stays out of the log
    }
    return res;
  } finally {
    timings.total_ms = Date.now() - t0;
    for (const st of states) try { fs.rmSync(st, { recursive: true, force: true }); } catch { /* next run */ }
    try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* left */ } }
    try { git(repo, ['worktree', 'prune']); } catch { /* ignore */ }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [inFile, outFile] = process.argv.slice(2);
  const item = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  runItem(item).then((r) => { fs.writeFileSync(outFile, `${JSON.stringify(r, null, 1)}\n`); })
    .catch((err) => {
      const leak = err?.code === 'MFR_LEAK';
      fs.writeFileSync(outFile, `${JSON.stringify({ id: item.id, eligible: false, exclusion: leak ? 'LEAK' : 'infra', infra_error: String(err?.message ?? err).slice(0, 300) }, null, 1)}\n`);
      console.error(String(err?.message ?? err)); process.exit(leak ? 3 : 1);
    });
}
