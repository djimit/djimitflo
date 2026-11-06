#!/usr/bin/env node
// L1/M1 skill `oracle-gate`: one call runs this goal's declared acceptance command, then the daemon's deterministic checks
// (LOOP_DAEMON_CHECK_SCRIPTS, default test:changed,lint,type-check), in the current worktree, and prints one verdict.
// Why: prod 10-31..11-05, 12/13 "maker failed after changing files" mutation runs were opencode makers stopped by the token
// brake, 7/13 decidable diffs already passed the lane oracle, and 5 makers had seen their own pass before the kill
// (docs/progress/flo-learning.md). PASS means stop: the daemon re-runs exactly these checks.
//
//   node scripts/skills/oracle-gate.mjs [--cwd <dir>] -- [NAME=value ...] <command ...>   (or ORACLE_GATE_COMMAND="...")
//   node scripts/skills/oracle-gate.mjs --doctor
//
// Output: `ORACLE_GATE {"pass":…,"checks":[{name,exit,ms}],"digest":"sha256:<hex of this file>"}` (single line; the server's
// transcript scan parses it) and one human line.
// NE-013: child output is never echoed. Of a mutation run only the score (status/before/after/gain) is kept: no mutant list,
// mutator, location or diff. Exit 0 = pass, 1 = fail, 2 = usage. It runs only test/lint/type-check commands; it never
// installs, pushes or writes (--doctor only looks). A check missing from package.json is skipped, as in production.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIGEST = `sha256:${createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex')}`;
const ROOT = process.cwd();
const SCRIPT_NAME = /^[\w:.-]{1,40}$/;
const CHECK_SCRIPT = /^(test|lint|type-check)([:.-][\w:.-]*)?$/;
const FORBIDDEN_ENV = /^(PATH|NODE_OPTIONS|LD_\w+|DYLD_\w+|npm_config_\w+)$/i;

function usage(msg) {
  console.error(`oracle-gate: ${msg}\nusage: oracle-gate.mjs [--cwd <dir>] -- [NAME=value ...] <npm run test*|lint*|type-check*, npx vitest run, npx tsc --noEmit, npx eslint, node --test> | --doctor`);
  process.exit(2);
}

/** Leading NAME=value tokens become env; the rest must be a test/lint/type-check command. null = not allowed. */
function parseCommand(tokens) {
  const env = {};
  let i = 0;
  for (; i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i]); i++) {
    const [k, ...v] = tokens[i].split('=');
    if (FORBIDDEN_ENV.test(k)) return null;
    env[k] = v.join('=');
  }
  const argv = tokens.slice(i);
  if (!argv.length || argv.some((t) => /[;&|`$<>(){}\n\\]/.test(t))) return null;
  const [cmd, a, b] = argv;
  const script = cmd === 'npm' && a === 'run' ? (b === '-s' ? argv[3] : b) ?? '' : '';
  const allowed = (SCRIPT_NAME.test(script) && CHECK_SCRIPT.test(script))
    || (cmd === 'npm' && a === 'test')
    || (cmd === 'npx' && ((a === 'vitest' && b === 'run') || (a === 'tsc' && argv.includes('--noEmit')) || a === 'eslint'))
    || (cmd === 'node' && a === '--test');
  return allowed ? { env, argv, script } : null;
}

function run(argv, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', (d) => { out = (out + d).slice(-65_536); }); // kept only to read a score line, never printed
    child.stderr.on('data', () => {});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
    const done = (exit) => { clearTimeout(timer); resolve({ exit: timedOut ? null : exit, ms: Date.now() - t0, timedOut, out }); };
    child.on('error', () => done(127));
    child.on('close', (code) => done(code));
  });
}

/** Only the score of a mutation-gain line: no file, test, mutant or location. */
function scoreOf(out) {
  const line = out.split('\n').reverse().find((l) => l.startsWith('{"mutation_gain"'));
  if (!line) return null;
  try { const m = JSON.parse(line).mutation_gain; return { status: m.status, before: m.before, after: m.after, gain: m.gain }; } catch { return null; }
}

function doctor(scripts) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts ?? {}; } catch { /* reported below */ }
  const file = (p) => ({ name: p, present: fs.existsSync(path.join(ROOT, p)) });
  const items = [
    file('package.json'),
    ...scripts.map((s) => ({ name: `script:${s}`, present: Object.hasOwn(pkg, s) })),
    file('node_modules'), file('node_modules/.bin/vitest'), file('node_modules/.bin/stryker'), file('node_modules/@stryker-mutator/vitest-runner'),
    file('node_modules/.bin/tsc'), file('node_modules/.bin/eslint'),
    file('stryker.service.config.mjs'), file('vitest.service-mutation.config.ts'), file('scripts/mutation-gain.mjs'),
    file('packages/shared/dist'),
  ];
  const ok = items.every((i) => i.present);
  console.log(`ORACLE_GATE_DOCTOR ${JSON.stringify({ ok, items, digest: DIGEST })}`);
  console.log(ok ? 'doctor: everything the oracle needs is present (nothing was installed)'
    : `doctor: missing ${items.filter((i) => !i.present).map((i) => i.name).join(', ')} (nothing was installed; ask the operator, do not install)`);
  process.exit(ok ? 0 : 1);
}

async function main() {
  const args = process.argv.slice(2);
  let cwd = '.';
  let isDoctor = false;
  let tokens = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { tokens = args.slice(i + 1); break; }
    if (args[i] === '--doctor') isDoctor = true;
    else if (args[i] === '--cwd' && args[i + 1] !== undefined) cwd = args[++i];
    else usage(`unknown argument ${args[i]}`);
  }
  const scripts = (process.env.LOOP_DAEMON_CHECK_SCRIPTS ?? 'test:changed,lint,type-check').split(',').map((s) => s.trim()).filter(Boolean);
  if (scripts.some((s) => !SCRIPT_NAME.test(s))) usage('LOOP_DAEMON_CHECK_SCRIPTS has an invalid script name');
  if (isDoctor) { if (tokens) usage('--doctor takes no command'); doctor(scripts); }
  if (!tokens) tokens = (process.env.ORACLE_GATE_COMMAND ?? '').trim().split(/\s+/).filter(Boolean);
  if (!fs.existsSync(path.join(ROOT, 'package.json'))) usage('run from the repository root (no package.json here)');
  const cmd = parseCommand(tokens);
  if (!cmd) usage(tokens.length ? 'the acceptance command must be a test, lint or type-check command' : 'no acceptance command');
  const dir = path.resolve(ROOT, cwd);
  if (path.relative(ROOT, dir).startsWith('..') || !fs.existsSync(dir)) usage(`--cwd ${cwd} is not a directory inside the repository`);

  const timeout = Number(process.env.LOOP_DAEMON_CHECK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 600_000) : 120_000; // daemonCheckOptions
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts ?? {}; } catch { /* scripts are skipped */ }
  const own = cmd.script && dir === ROOT ? cmd.script : null; // the acceptance script is not run twice

  const checks = [];
  let failed = null;
  const record = (name, r, extra = {}) => {
    checks.push({ name, exit: r.exit, ms: r.ms, ...(r.timedOut ? { timed_out: true } : {}), ...extra });
    if (r.exit !== 0 && !failed) failed = name;
  };
  const acceptance = cmd.argv.join(' ');
  const a = await run(cmd.argv, dir, cmd.env, timeoutMs);
  const score = scoreOf(a.out);
  record(acceptance, a, score ? { score } : {});
  for (const s of scripts.filter((s) => s !== own)) {
    if (failed) { checks.push({ name: s, exit: null, ms: 0, skipped: 'after failure' }); continue; }
    if (!Object.hasOwn(pkg, s)) { checks.push({ name: s, exit: null, ms: 0, skipped: 'not in package.json' }); continue; }
    record(s, await run(['npm', 'run', s], ROOT, cmd.env, timeoutMs));
  }
  console.log(`ORACLE_GATE ${JSON.stringify({ pass: !failed, checks, digest: DIGEST })}`);
  console.log(failed ? `FAIL: ${failed} → fix only that` : 'PASS → stop working, report done');
  process.exit(failed ? 1 : 0);
}

main();
