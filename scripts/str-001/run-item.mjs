#!/usr/bin/env node
// STR-001 Stage A item runner, WORKSTATION CPU ONLY (protocol "Procedure"). No maker, no model, no GPU, no network
// except npm ci and the git clone. One item at a time:
//   nice -n 10 node run-item.mjs <manifest.local.json> <item id> <result.json>
// Rebuilds the item at its base commit in a throwaway worktree of its own clone (~/str-001/repo), installs with npm ci in
// the gym runner image (used only as a Node 22 toolbox; atomic-agent is never started), then scores the ORIGINAL test and
// the STRENGTHEN-retried test on (a) the fresh gym mutants (one vitest run per mutant) and (b) Stryker mutants of the
// target (the repo-pinned @stryker-mutator/core, the repo's mutator set). Containers are labelled
// djimitflo-gym-host=str-001, niced and CPU-capped; the gym worker's containers, repo and units are never touched.
// Exit codes: 0 done (any outcome), 1 harness error.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUDED_MUTATIONS, applyDescriptor, assertDisjoint, gymKill, sha256, strengthenClass, strykerKill, strykerSet, strykerSlice, strykerTable } from './lib.mjs';

const env = process.env;
const WORK = (env.STR_WORK || path.join(os.homedir(), 'str-001')).replace(/^~/, os.homedir());
// the gym runner image plus procps (Stryker's process-tree kill needs ps); built locally as str-001-runner:1:
//   FROM djimitflo-gym-runner:atomic-0.6.5 / RUN apt-get install -y procps
const IMAGE = env.STR_RUNNER_IMAGE || 'str-001-runner:1';
const NPM_VOLUME = 'str-001-npm';
const LABEL = 'djimitflo-gym-host=str-001';
const CPUS = env.STR_CPUS || '8';
const CONCURRENCY = env.STR_CONCURRENCY || '4';
const VITEST_TIMEOUT_MS = 180_000;
const STRYKER_TIMEOUT_MS = Number(env.STR_STRYKER_TIMEOUT_MS || 5_400_000);
const STRYKER_VERSION = '10.0.0'; // package.json devDependency (root), checked in the installed tree

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts });
const git = (cwd, args) => sh('git', ['-C', cwd, ...args]);
let seq = 0;
const cpuTotal = { ms: 0, unmeasured: 0 };
/** One runner container, niced, CPU-capped, named and labelled so a timeout can remove it. No model endpoint is mounted. */
function inRunner(wt, cmd, { timeoutMs = 900_000, extra = [] } = {}) {
  const n = seq++; const name = `str-001-${process.pid}-${n}`; const cpuFile = `.str001-cpu-${n}`;
  // `times` after the subshell: user + sys CPU of everything the command ran (the CPU-hours figure in the result)
  const wrapped = `( ${cmd} ); rc=$?; times > /w/${cpuFile}; exit $rc`;
  const args = ['run', '--rm', '--name', name, '--label', LABEL, '--cpus', CPUS, '--network', 'host', '-v', `${wt}:/w`, '-v', `${NPM_VOLUME}:/root/.npm`, '-w', '/w', ...extra, IMAGE, 'nice', '-n', '10', 'sh', '-c', wrapped];
  const t = Date.now();
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 });
  if (r.error || r.signal) spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 60_000 });
  r.ms = Date.now() - t;
  try {
    const secs = [...fs.readFileSync(path.join(wt, cpuFile), 'utf8').matchAll(/(\d+)m([\d.]+)s/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
    r.cpu_ms = Math.round(1000 * secs.reduce((a, b) => a + b, 0)); cpuTotal.ms += r.cpu_ms;
    fs.rmSync(path.join(wt, cpuFile), { force: true });
  } catch { r.cpu_ms = null; cpuTotal.unmeasured++; }
  return r;
}

// runs inside the container: each variant of the target in turn, one vitest run of the test file each, target restored
const VARIANT_RUNNER = `const fs=require('fs');const {spawnSync}=require('child_process');
const v=JSON.parse(fs.readFileSync('/w/.str001/variants.json','utf8'));const file='/w/'+v.target;const orig=fs.readFileSync(file,'utf8');const out=[];
try{for(const x of v.variants){fs.writeFileSync(file,x.content===null?orig:x.content);
const r=spawnSync('npx',['vitest','run',v.test],{cwd:'/w/packages/server',timeout:v.timeout,stdio:'ignore'});
out.push({name:x.name,result:r.error||r.signal?'timeout':r.status===0?'pass':'fail'});}}finally{fs.writeFileSync(file,orig);}
fs.writeFileSync('/w/.str001/variants-out.json',JSON.stringify(out));`;

/** The server's own vitest config, restricted to the one test file (MFR-001 scored with `npx vitest run <test>` there). */
const VITEST_CONFIG = `import base from './vitest.config.mts';
const b: any = base;
if (typeof b === 'function' || !b?.test) throw new Error('str-001: packages/server/vitest.config.mts is not a plain config object');
export default { ...b, test: { ...b.test, include: [process.env.STR_TEST as string] } };
`;
/** Stryker in place on the target, the repo's mutator set (stryker.config.js / stryker.service.config.mjs), JSON report. */
const STRYKER_CONFIG = `export default {
  mutate: [process.env.STR_MUTATE],
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { dir: '.', related: false, configFile: 'vitest.str-001.config.mts' },
  inPlace: true,
  coverageAnalysis: 'perTest',
  concurrency: Number(process.env.STR_CONCURRENCY || 4),
  reporters: ['json'],
  jsonReporter: { fileName: process.env.STR_REPORT },
  mutator: { excludedMutations: ${JSON.stringify(EXCLUDED_MUTATIONS)} },
  tempDirName: '.stryker-tmp-str001',
  cleanTempDir: true,
};
`;

/** Runs the current test file against the real target and each named mutant; the variant files are removed afterwards. */
function runVariants(wt, item, variants) {
  const dir = path.join(wt, '.str001'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'variants.json'), JSON.stringify({ target: item.target, test: item.test.replace(/^packages\/server\//, ''), timeout: VITEST_TIMEOUT_MS, variants }));
  fs.writeFileSync(path.join(dir, 'variant-runner.cjs'), VARIANT_RUNNER);
  try {
    const r = inRunner(wt, 'node /w/.str001/variant-runner.cjs', { timeoutMs: VITEST_TIMEOUT_MS * (variants.length + 1) });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'variants-out.json'), 'utf8'));
    if (r.status !== 0 || out.length !== variants.length) throw new Error(`variant runner exit ${r.status}`);
    return { ms: r.ms, out: Object.fromEntries(out.map((o) => [o.name, o.result])) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** One Stryker run of the current test file; returns { report } or { error }. The target is verified afterwards. */
function runStryker(wt, item, original, tag) {
  const report = `/w/.str001-reports/${tag}.json`;
  fs.mkdirSync(path.join(wt, '.str001-reports'), { recursive: true });
  const testRel = item.test.replace(/^packages\/server\//, ''); const mutateRel = item.target.replace(/^packages\/server\//, '');
  const cmd = `cd /w/packages/server && STR_TEST='${testRel}' STR_MUTATE='${mutateRel}' STR_REPORT='${report}' STR_CONCURRENCY='${CONCURRENCY}' npx stryker run str-001.stryker.config.mjs > /w/.str001-reports/${tag}.log 2>&1`;
  const r = inRunner(wt, cmd, { timeoutMs: STRYKER_TIMEOUT_MS });
  const local = path.join(wt, '.str001-reports', `${tag}.json`);
  const logTail = (() => { try { return fs.readFileSync(path.join(wt, '.str001-reports', `${tag}.log`), 'utf8').slice(-1500); } catch { return ''; } })();
  // in-place mutation must leave the real target behind; restore it either way
  const after = fs.readFileSync(path.join(wt, item.target), 'utf8');
  const targetRestored = sha256(after) === sha256(original);
  if (!targetRestored) fs.writeFileSync(path.join(wt, item.target), original);
  fs.rmSync(path.join(wt, 'packages/server/.stryker-tmp-str001'), { recursive: true, force: true });
  if (r.status !== 0 || !fs.existsSync(local)) return { ms: r.ms, error: `stryker exit ${r.status}${r.signal ? ` ${r.signal}` : ''}${r.error ? ` ${r.error.code}` : ''}`, log_tail: logTail, target_restored: targetRestored };
  const json = JSON.parse(fs.readFileSync(local, 'utf8')); fs.rmSync(local, { force: true });
  return { ms: r.ms, report: json, target_restored: targetRestored };
}

const compactTable = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.status]));

export async function runItem(item) {
  const t0 = Date.now(); const timings = {};
  const res = { id: item.id, eligible: false, exclusion: null, host: os.hostname(), image: IMAGE, started_at: new Date(t0).toISOString(), timings, families: {}, strengthen: {}, size: item.size };
  fs.mkdirSync(WORK, { recursive: true });
  const repo = path.join(WORK, 'repo');
  if (!fs.existsSync(repo)) sh('git', ['clone', '-q', 'https://github.com/djimit/djimitflo.git', repo]);
  try { git(repo, ['cat-file', '-e', `${item.base}^{commit}`]); } catch { git(repo, ['fetch', '-q', 'origin', item.base]); }
  const wt = fs.mkdtempSync(path.join(WORK, 'wt-'));
  try {
    git(repo, ['worktree', 'add', '-q', '--detach', wt, item.base]);
    const original = fs.readFileSync(path.join(wt, item.target), 'utf8');
    if (sha256(original) !== item.target_sha256) throw new Error('target at base differs from the manifest');
    if (sha256(item.original_test) !== item.original_test_sha256) throw new Error('original test sha256 differs from the manifest');
    if (item.retried_test !== null && sha256(item.retried_test) !== item.retried_test_sha256) throw new Error('retried test sha256 differs from the manifest (redacted copy?)');
    // rebuild every mutant from its descriptor and re-assert disjointness on the workstation
    const content = (d) => { const c = applyDescriptor(original, d); if (c === null || sha256(c) !== d.sha256) throw new Error(`mutant ${d.key} does not rebuild`); return c; };
    const mfr = item.mfr_mutants.map((d) => ({ ...d, content: content(d) }));
    const famA = item.family_a.map((d) => ({ ...d, content: content(d) }));
    assertDisjoint(famA, mfr);
    res.disjointness = { family_a_vs_mfr: 'pass', n_mfr: mfr.length, n_family_a: famA.length };
    fs.mkdirSync(path.dirname(path.join(wt, item.test)), { recursive: true });
    fs.writeFileSync(path.join(wt, item.test), item.original_test);
    git(wt, ['add', '--', item.test]);
    git(wt, ['-c', 'user.email=str-001@djimitflo', '-c', 'user.name=str-001', 'commit', '-q', '--allow-empty', '-m', `str-001: original test of lease ${item.id}`]);
    let t = Date.now();
    const ci = inRunner(wt, '(npm ci --legacy-peer-deps --no-audit --no-fund && npm run build -w @djimitflo/shared && npm run build -w @djimitflo/agent-catalog) > /tmp/ci.log 2>&1; rc=$?; tail -15 /tmp/ci.log; exit $rc', { timeoutMs: 1_200_000 });
    timings.npm_ci_ms = Date.now() - t;
    if (ci.status !== 0) { res.exclusion = 'infra'; res.infra_error = `npm ci failed: ${(ci.stdout || ci.stderr || '').slice(-300)}`; return res; }
    // the repo-pinned Stryker, and the repo's own mutator set at this base
    const core = JSON.parse(fs.readFileSync(path.join(wt, 'node_modules/@stryker-mutator/core/package.json'), 'utf8')).version;
    const vr = JSON.parse(fs.readFileSync(path.join(wt, 'node_modules/@stryker-mutator/vitest-runner/package.json'), 'utf8')).version;
    const repoCfg = fs.readFileSync(path.join(wt, 'stryker.service.config.mjs'), 'utf8');
    const repoSet = /excludedMutations:\s*\[\s*'StringLiteral',\s*'ObjectLiteral'\s*\]/.test(repoCfg);
    res.stryker = { core, vitest_runner: vr, repo_mutator_set_matches: repoSet };
    if (core !== STRYKER_VERSION || !repoSet) { res.exclusion = 'infra'; res.infra_error = `stryker pin / mutator set differs at base (core ${core}, set ${repoSet})`; return res; }
    fs.writeFileSync(path.join(wt, 'packages/server/vitest.str-001.config.mts'), VITEST_CONFIG);
    fs.writeFileSync(path.join(wt, 'packages/server/str-001.stryker.config.mjs'), STRYKER_CONFIG);

    const variants = [{ name: 'base', content: null }, ...famA.map((d) => ({ name: d.key, content: d.content }))];
    const score = (tag) => {
      const v = runVariants(wt, item, variants);
      const out = { baseline: v.out.base, gym_runs: famA.map((d) => v.out[d.key]), gym_ms: v.ms };
      if (out.baseline !== 'pass') return out;
      const s = runStryker(wt, item, original, tag);
      Object.assign(out, { stryker_ms: s.ms, stryker_target_restored: s.target_restored });
      if (s.error) Object.assign(out, { stryker_error: s.error, stryker_log_tail: s.log_tail });
      else out.stryker_table = strykerTable(s.report);
      return out;
    };
    // ORIGINAL test
    t = Date.now();
    const o = score('original'); timings.original_ms = Date.now() - t;
    res.original = { baseline: o.baseline, gym_runs: o.gym_runs, stryker_error: o.stryker_error ?? null, stryker_log_tail: o.stryker_log_tail ?? null, stryker_ms: o.stryker_ms ?? null };
    if (o.baseline !== 'pass') { res.exclusion = 'original_red_at_base'; return res; }
    res.eligible = true;
    // STRENGTHEN-retried test (MFR-001 control arm), when the retry left one
    let r = null;
    if (item.retried_test !== null) {
      fs.writeFileSync(path.join(wt, item.test), item.retried_test);
      t = Date.now(); r = score('strengthen'); timings.strengthen_ms = Date.now() - t;
      fs.writeFileSync(path.join(wt, item.test), item.original_test);
    }
    const cls = strengthenClass({ hasRetried: item.retried_test !== null, baseline: r?.baseline ?? null });
    res.strengthen = { class: cls, baseline: r?.baseline ?? null, gym_runs: r?.gym_runs ?? null, stryker_error: r?.stryker_error ?? null, stryker_log_tail: r?.stryker_log_tail ?? null, stryker_ms: r?.stryker_ms ?? null };
    // family (a): fresh gym mutants
    res.families.gym = item.family_a_eligible
      ? { n_mutants: famA.length, original: gymKill(o.gym_runs), strengthen: cls === 'ok' ? gymKill(r.gym_runs) : null }
      : { n_mutants: famA.length, excluded: 'too_few_fresh_gym_mutants', original: null, strengthen: null };
    // family (b): Stryker mutants of the target, minus every MFR-001 mutant content
    if (!o.stryker_table) res.families.stryker = { excluded: 'stryker_infra_original', original: null, strengthen: null };
    else {
      const set = strykerSet(original, o.stryker_table, mfr.map((m) => m.content));
      const sample = set.keys.slice(0, 3).map((k) => ({ k, slice: strykerSlice(original, o.stryker_table[k].m) }));
      const fam = { n_reported: Object.keys(o.stryker_table).length, n_mutants: set.keys.length, dropped: set.dropped, slice_sample: sample, original: strykerKill(o.stryker_table, set.keys), strengthen: null };
      if (cls === 'ok') {
        if (r.stryker_table) {
          const missing = set.keys.filter((k) => !r.stryker_table[k]);
          if (missing.length) throw new Error(`stryker: ${missing.length} mutant identities missing from the retried run`);
          fam.strengthen = strykerKill(r.stryker_table, set.keys);
          fam.statuses = Object.fromEntries(set.keys.map((k) => [k, [o.stryker_table[k].status, r.stryker_table[k].status]]));
        } else fam.infra_strengthen = r.stryker_error ?? 'no report';
      } else fam.statuses = Object.fromEntries(set.keys.map((k) => [k, [o.stryker_table[k].status, null]]));
      fam.all_original_statuses = compactTable(o.stryker_table);
      res.families.stryker = fam;
    }
    return res;
  } finally {
    timings.total_ms = Date.now() - t0; timings.cpu_ms = cpuTotal.ms; timings.cpu_unmeasured_runs = cpuTotal.unmeasured;
    try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* left */ } }
    try { git(repo, ['worktree', 'prune']); } catch { /* ignore */ }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [manifestFile, id, outFile] = process.argv.slice(2);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const item = manifest.units.find((u) => u.id === id);
  if (!item) { console.error(`no unit ${id}`); process.exit(1); }
  runItem(item).then((r) => { fs.writeFileSync(outFile, `${JSON.stringify(r)}\n`); })
    .catch((err) => {
      fs.writeFileSync(outFile, `${JSON.stringify({ id, eligible: false, exclusion: 'infra', infra_error: String(err?.stack ?? err).slice(0, 600) })}\n`);
      console.error(String(err?.message ?? err)); process.exit(1);
    });
}
