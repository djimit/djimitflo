#!/usr/bin/env node
// L1/M1 replay (operator, offline): runs oracle-gate on stored maker diffs and compares its verdict with the lane oracle.
// Per case: a throwaway git worktree of this repo at the last origin/main commit before the lease's created_at (the real
// worktree base is not stored, so this is an approximation), node_modules linked read-only from the installed checkout
// (of a comma-separated list) whose package-lock.json is closest to the base's (the remaining differences are recorded),
// shared/agent-catalog built, the diff applied, then `oracle-gate.mjs` with the case's acceptance command. The worktree and
// the diff file are removed afterwards. Diffs come from the operator evidence dir and are never written to the output.
//
//   node scripts/skills/oracle-gate-replay.mjs --cases <cases.json> --node-modules <installed checkout> --out <dir>
//     [--reference <lane-oracle replay.jsonl>] [--only <lease prefix,...>] [--jobs N] [--checks a,b,c] [--apply]
//
// Without --apply it is a dry run: it prints each case's base commit and command and creates nothing. Unknown flag: exit 2.
// cases.json: [{ lane, lease, created, status, rt, grounding: { runtimeCommand, artifactPath }, diff, deterministic_checks }]
// Reference: mutation lane = the earlier lane-oracle replay (`oracle` JSON line per lease; no test change = FAIL; a
// baseline_unavailable row falls back to prod's recorded test:mutation:grounded exit, else undecidable). Exports lane =
// prod's recorded daemon checks (all exit 0 = PASS). Output: <out>/replay-oracle-gate.json and .md.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const GATE = path.join(HERE, 'oracle-gate.mjs');
const FLAGS = { '--cases': 1, '--node-modules': 1, '--out': 1, '--reference': 1, '--only': 1, '--jobs': 1, '--checks': 1, '--apply': 0 };

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!(argv[i] in FLAGS) || (FLAGS[argv[i]] && argv[i + 1] === undefined)) { console.error(`oracle-gate-replay: unknown or incomplete argument ${argv[i]}`); process.exit(2); }
    o[argv[i].slice(2)] = FLAGS[argv[i]] ? argv[++i] : true;
  }
  if (!o.cases || !o.out || (o.apply && !o['node-modules'])) { console.error('oracle-gate-replay: --cases and --out are required (and --node-modules with --apply)'); process.exit(2); }
  return o;
}

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const short = (s) => String(s).slice(0, 8);

/** The lane-oracle verdict this case is compared with: true / false / null (undecidable). */
export function referenceVerdict(c, ref) {
  const prodCheck = (name) => c.deterministic_checks?.find((d) => d.name === name)?.exit_status;
  if (c.lane === 'exports') {
    const daemon = ['test:changed', 'lint', 'type-check'].map(prodCheck);
    if (daemon.some((e) => e === undefined)) return { verdict: null, source: 'prod daemon checks not recorded' };
    return { verdict: daemon.every((e) => e === 0), source: `prod daemon checks ${daemon.map((e) => e ?? 'timeout').join('/')}` };
  }
  if (ref && ref.changed === '') return { verdict: false, source: 'lane-oracle replay: no test change' };
  let m = null;
  try { m = JSON.parse(ref?.oracle ?? 'null')?.mutation_gain ?? null; } catch { /* below */ }
  if (m && m.status !== 'baseline_unavailable') return { verdict: m.pass === true, source: `lane-oracle replay ${m.status} ${m.before}→${m.after}` };
  const prod = prodCheck('test:mutation:grounded');
  if (prod === 0 || prod === 1) return { verdict: prod === 0, source: `prod test:mutation:grounded exit ${prod}` };
  return { verdict: null, source: m ? `undecidable: ${m.status}, no prod oracle run` : 'undecidable: no reference' };
}

/** Where the acceptance command runs: the repo root, or the package that contains the test file it names (exports lane;
 *  call after the diff is applied, so a new test file exists). */
export function commandCwd(tokens, wt) {
  const rel = tokens.find((t) => /\.(test|spec)\.[cm]?[jt]s$/.test(t));
  if (!rel || fs.existsSync(path.join(wt, rel)) || path.isAbsolute(rel)) return '.';
  for (const p of fs.readdirSync(path.join(wt, 'packages'))) if (fs.existsSync(path.join(wt, 'packages', p, rel))) return `packages/${p}`;
  return '.';
}

/** Package versions in `lock` that differ from `base` (missing counts as different). */
export function lockDiff(base, lock) {
  const b = base?.packages ?? {}, l = lock?.packages ?? {};
  return Object.keys(b).filter((k) => k.startsWith('node_modules/') && b[k]?.version !== l[k]?.version).map((k) => `${k.slice(13)}@${b[k]?.version}`);
}

/** The installed checkout whose package-lock.json is closest to the base's; the remaining differences are recorded. */
function pickNodeModules(dirs, wt) {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const base = read(path.join(wt, 'package-lock.json'));
  return dirs.map((dir) => ({ dir, diff: lockDiff(base, read(path.join(dir, 'package-lock.json'))) })).sort((a, b) => a.diff.length - b.diff.length)[0];
}

function linkNodeModules(src, wt) {
  const nm = path.join(wt, 'node_modules');
  fs.mkdirSync(path.join(nm, '@djimitflo'), { recursive: true });
  for (const e of fs.readdirSync(path.join(src, 'node_modules'))) if (e !== '@djimitflo') fs.symlinkSync(path.join(src, 'node_modules', e), path.join(nm, e));
  for (const p of fs.readdirSync(path.join(wt, 'packages'))) {
    fs.symlinkSync(`../../packages/${p}`, path.join(nm, '@djimitflo', p));
    const pm = path.join(src, 'packages', p, 'node_modules');
    if (fs.existsSync(pm) && !fs.existsSync(path.join(wt, 'packages', p, 'node_modules'))) fs.symlinkSync(pm, path.join(wt, 'packages', p, 'node_modules'));
  }
}

function sh(cmd, args, cwd, env = {}) {
  return new Promise((resolve) => {
    let out = '';
    const ch = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', () => {});
    ch.on('close', (code) => resolve({ code, out }));
  });
}

let gitLock = Promise.resolve();
const serial = (fn) => { const p = gitLock.then(fn); gitLock = p.catch(() => {}); return p; };

async function replay(c, o, ref) {
  const tokens = String(c.grounding?.runtimeCommand ?? '').trim().split(/\s+/);
  const base = git(['rev-list', '-1', `--before=${c.created}`, 'origin/main']);
  const row = { lane: c.lane, lease: short(c.lease), rt: c.rt, prod_status: c.status, base: short(base), base_rule: 'last origin/main commit before lease created_at (approximation)',
    reference: referenceVerdict(c, ref) };
  if (!o.apply) return { ...row, dry_run: `would: worktree at ${short(base)}, apply ${c.diff.split('\n').filter((l) => l.startsWith('diff --git')).length} file diff(s), run oracle-gate -- ${tokens.join(' ')}` };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ogr-${short(c.lease)}-`));
  const wt = path.join(tmp, 'wt');
  try {
    await serial(() => git(['worktree', 'add', '--detach', '-q', wt, base]));
    const nm = pickNodeModules(o['node-modules'].split(','), wt);
    linkNodeModules(nm.dir, wt);
    row.node_modules = { source: path.basename(nm.dir), lock_versions_differing_from_base: nm.diff };
    const diffFile = path.join(tmp, 'case.diff');
    fs.writeFileSync(diffFile, c.diff.endsWith('\n') ? c.diff : `${c.diff}\n`);
    let apply = await sh('git', ['apply', '--whitespace=nowarn', diffFile], wt);
    row.apply = apply.code === 0 ? 'full' : null;
    if (apply.code !== 0 && c.grounding?.artifactPath) {
      apply = await sh('git', ['apply', '--whitespace=nowarn', `--include=${c.grounding.artifactPath}`, diffFile], wt);
      row.apply = apply.code === 0 ? 'artifact only' : 'failed';
    }
    fs.rmSync(diffFile, { force: true });
    if (row.apply === 'failed' || row.apply === null) return { ...row, gate: null };
    for (const p of ['shared', 'agent-catalog']) row[`build_${p}`] = (await sh(path.join(wt, 'node_modules/.bin/tsc'), ['-p', `packages/${p}`], wt)).code;
    const t0 = Date.now();
    const g = await sh(process.execPath, [GATE, '--cwd', commandCwd(tokens, wt), '--', ...tokens], wt,
      { LOOP_DAEMON_CHECK_SCRIPTS: o.checks ?? 'test:changed,lint,type-check', LOOP_DAEMON_CHECK_TIMEOUT_MS: '600000' });
    const line = g.out.split('\n').find((l) => l.startsWith('ORACLE_GATE '));
    row.gate = line ? JSON.parse(line.slice('ORACLE_GATE '.length)) : { error: `gate exit ${g.code}, no verdict line` };
    row.gate_exit = g.code;
    row.secs = Math.round((Date.now() - t0) / 1000);
    const first = row.gate.checks?.[0];
    row.acceptance_pass = first ? first.exit === 0 : null;
    row.full_gate_pass = row.gate.pass ?? null;
    const mine = c.lane === 'exports' ? row.full_gate_pass : row.acceptance_pass;
    row.agrees = row.reference.verdict === null || mine === null ? null : mine === row.reference.verdict;
    return row;
  } finally {
    await serial(() => { try { git(['worktree', 'remove', '--force', wt]); } catch { /* pruned below */ } });
    fs.rmSync(tmp, { recursive: true, force: true });
    await serial(() => { try { git(['worktree', 'prune']); } catch { /* best effort */ } });
  }
}

function summarize(rows) {
  const decided = rows.filter((r) => r.agrees !== null && r.agrees !== undefined);
  const byLane = {};
  for (const r of decided) { const l = (byLane[r.lane] ??= { decidable: 0, agree: 0 }); l.decidable++; if (r.agrees) l.agree++; }
  const thrownAway = rows.filter((r) => r.lane === 'mutation' && r.prod_status === 'failed' && r.rt === 'opencode' && r.full_gate_pass === true).map((r) => r.lease);
  const killedAccepted = rows.filter((r) => r.lane === 'mutation' && r.prod_status === 'failed' && r.rt === 'opencode' && r.acceptance_pass === true).map((r) => r.lease);
  return { cases: rows.length, undecidable: rows.filter((r) => r.reference?.verdict === null).map((r) => r.lease), by_lane: byLane,
    disagreements: decided.filter((r) => !r.agrees).map((r) => r.lease), failed_opencode_makers_passing_acceptance: killedAccepted,
    failed_opencode_makers_passing_full_gate: thrownAway };
}

function markdown(s, rows, o) {
  const cell = (r) => (r.gate?.checks ?? []).map((c) => `${c.name}=${c.exit ?? (c.skipped ? '–' : 'timeout')}`).join(', ');
  return [`# oracle-gate replay (${new Date().toISOString().slice(0, 16)}Z)`, '',
    `Gate digest: \`${rows.find((r) => r.gate?.digest)?.gate.digest ?? 'n/a'}\`. Checks: ${o.checks ?? 'test:changed,lint,type-check'}, timeout 600 s each.`,
    'Base: last origin/main commit before the lease was created (the real worktree base is not stored).', '',
    ...Object.entries(s.by_lane).map(([l, v]) => `- **${l}**: agreement ${v.agree}/${v.decidable} decidable`),
    `- undecidable: ${s.undecidable.join(', ') || 'none'}`, `- disagreements: ${s.disagreements.join(', ') || 'none'}`,
    `- failed opencode mutation makers whose diff passes the acceptance command: ${s.failed_opencode_makers_passing_acceptance.length} (${s.failed_opencode_makers_passing_acceptance.join(', ')})`,
    `- ... and the FULL gate (thrown-away useful repairs): ${s.failed_opencode_makers_passing_full_gate.length} (${s.failed_opencode_makers_passing_full_gate.join(', ')})`, '',
    '| lane | lease | rt | prod | base | apply | reference | gate checks | acceptance | full gate | agrees | s |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.lane} | ${r.lease} | ${r.rt} | ${r.prod_status} | ${r.base} | ${r.apply ?? '–'} | ${r.reference.verdict === null ? 'U' : r.reference.verdict ? 'PASS' : 'FAIL'} (${r.reference.source}) | ${cell(r)}${r.gate?.checks?.[0]?.score ? ` [${r.gate.checks[0].score.before}→${r.gate.checks[0].score.after}]` : ''} | ${r.acceptance_pass ?? '–'} | ${r.full_gate_pass ?? '–'} | ${r.agrees ?? '–'} | ${r.secs ?? '–'} |`),
    ''].join('\n');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let cases = JSON.parse(fs.readFileSync(o.cases, 'utf8'));
  if (o.only) { const only = o.only.split(','); cases = cases.filter((c) => only.some((p) => c.lease.startsWith(p))); }
  const refs = new Map();
  if (o.reference) for (const l of fs.readFileSync(o.reference, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); refs.set(r.lease, r); }
  const jobs = Math.max(1, Math.min(Number(o.jobs) || 1, 4));
  const rows = new Array(cases.length);
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < cases.length) {
      const i = next++;
      rows[i] = await replay(cases[i], o, refs.get(short(cases[i].lease)));
      console.log(JSON.stringify(rows[i]));
    }
  }));
  if (!o.apply) { console.log(`dry run: ${rows.length} case(s) planned, no worktree created; add --apply to run`); return; }
  const summary = summarize(rows);
  fs.mkdirSync(o.out, { recursive: true });
  fs.writeFileSync(path.join(o.out, 'replay-oracle-gate.json'), JSON.stringify({ generated_at: new Date().toISOString(), summary, rows }, null, 2));
  fs.writeFileSync(path.join(o.out, 'replay-oracle-gate.md'), markdown(summary, rows, o));
  console.log(JSON.stringify(summary));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
