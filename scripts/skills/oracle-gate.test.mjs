// L1/M1 oracle-gate: one call runs the goal's acceptance command plus the daemon checks and prints one verdict.
// Each case gets a throwaway repo whose package.json scripts are tiny node one-liners; nothing real is installed or run.
// Run: node scripts/skills/oracle-gate.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oracle-gate.mjs');
const ok = 'node -e "process.exit(0)"';
const bad = 'node -e "process.exit(1)"';

// What a Stryker/mutation run can leak (NE-013): mutant ids, mutator names, replacements, file:line:col locations, diffs.
const LEAK = 'console.log(JSON.stringify({mutants:[{id:"17",mutatorName:"ConditionalExpression",replacement:"true",status:"Survived",'
  + 'location:{start:{line:42,column:7}}}]}));console.log("Survived ConditionalExpression src/services/widget.ts:42:7");'
  + 'console.error("diff --git a/src/services/widget.ts b/src/services/widget.ts\\n@@ -42,7 +42,7 @@\\n-  if (a) {\\n+  if (true) {");';
const LEAK_SCORE = `node -e '${LEAK}console.log(JSON.stringify({mutation_gain:{status:"ok",file:"src/services/widget.ts",test:"src/widget.test.ts",before:40,after:SCORE,gain:SCORE-40,min_gain:10,rule:null,pass:SCORE>=50}}));process.exit(SCORE>=50?0:1)'`;

function repo(scripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-gate-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts }));
  return dir;
}

function gate(dir, args, env = {}) {
  const p = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, LOOP_DAEMON_CHECK_SCRIPTS: '', ...env } });
  const out = `${p.stdout}${p.stderr}`;
  const line = p.stdout.split('\n').find((l) => l.startsWith('ORACLE_GATE '));
  return { code: p.status, out, verdict: line ? JSON.parse(line.slice('ORACLE_GATE '.length)) : null };
}

const CHECKS = { LOOP_DAEMON_CHECK_SCRIPTS: 'test:changed,lint,type-check' };

test('acceptance and every daemon check exit 0: PASS, exit 0, one machine line, stop instruction', () => {
  const dir = repo({ 'test:accept': ok, 'test:changed': ok, lint: ok, 'type-check': ok });
  const r = gate(dir, ['--', 'npm', 'run', 'test:accept'], CHECKS);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.verdict.pass, true);
  assert.deepEqual(r.verdict.checks.map((c) => [c.name, c.exit]), [['npm run test:accept', 0], ['test:changed', 0], ['lint', 0], ['type-check', 0]]);
  for (const c of r.verdict.checks) assert.equal(typeof c.ms, 'number');
  assert.match(r.out, /PASS → stop working, report done/);
});

test('the default check set is test:changed,lint,type-check when LOOP_DAEMON_CHECK_SCRIPTS is unset', () => {
  const dir = repo({ 'test:accept': ok, 'test:changed': ok, lint: ok, 'type-check': ok });
  const env = { ...process.env }; delete env.LOOP_DAEMON_CHECK_SCRIPTS;
  const p = spawnSync(process.execPath, [SCRIPT, '--', 'npm', 'run', 'test:accept'], { cwd: dir, encoding: 'utf8', env });
  const v = JSON.parse(p.stdout.split('\n').find((l) => l.startsWith('ORACLE_GATE ')).slice(12));
  assert.deepEqual(v.checks.map((c) => c.name), ['npm run test:accept', 'test:changed', 'lint', 'type-check']);
});

test('a failing daemon check: FAIL names that check, exit 1, later checks do not run', () => {
  const dir = repo({ 'test:accept': ok, 'test:changed': ok, lint: bad, 'type-check': ok });
  const r = gate(dir, ['--', 'npm', 'run', 'test:accept'], CHECKS);
  assert.equal(r.code, 1, r.out);
  assert.equal(r.verdict.pass, false);
  assert.match(r.out, /FAIL: lint → fix only that/);
  assert.deepEqual(r.verdict.checks.find((c) => c.name === 'type-check'), { name: 'type-check', exit: null, ms: 0, skipped: 'after failure' });
});

test('a failing acceptance command fails the gate before any daemon check runs', () => {
  const dir = repo({ 'test:accept': bad, 'test:changed': ok, lint: ok, 'type-check': ok });
  const r = gate(dir, ['--', 'npm', 'run', 'test:accept'], CHECKS);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL: npm run test:accept → fix only that/);
  assert.ok(r.verdict.checks.slice(1).every((c) => c.exit === null));
});

test('NE-013: no mutant id, mutator, replacement, location or diff reaches the output — on PASS and on FAIL', () => {
  for (const score of [95, 41]) {
    const dir = repo({ 'test:mutation:grounded': LEAK_SCORE.replaceAll('SCORE', String(score)), 'test:changed': LEAK_SCORE.replaceAll('SCORE', '95') });
    const r = gate(dir, ['--', 'MUTATE_FILE=src/services/widget.ts', 'MUTATE_TEST=src/widget.test.ts', 'npm', 'run', 'test:mutation:grounded'],
      { LOOP_DAEMON_CHECK_SCRIPTS: 'test:changed' });
    assert.equal(r.code, score >= 50 ? 0 : 1, r.out);
    for (const leak of [/mutatorName/, /ConditionalExpression/, /replacement/, /Survived/i, /location/, /"id"/, /mutants/, /widget\.ts/, /:\d+:\d+/, /diff --git/, /@@/, /if \(true\)/]) {
      assert.doesNotMatch(r.out, leak, `leaked ${leak} (score ${score})`);
    }
    // only a score: status, before, after, gain
    assert.deepEqual(r.verdict.checks[0].score, { status: 'ok', before: 40, after: score, gain: score - 40 });
  }
});

test('leading NAME=value tokens are the command env, also passed to the daemon checks (as the daemon passes MUTATE_*)', () => {
  const echo = `node -e "process.exit(process.env.MUTATE_FILE==='x.ts'?0:3)"`;
  const dir = repo({ 'test:mutation:grounded': echo, 'test:changed': echo });
  const r = gate(dir, ['--', 'MUTATE_FILE=x.ts', 'npm', 'run', 'test:mutation:grounded'], { LOOP_DAEMON_CHECK_SCRIPTS: 'test:changed,test:mutation:grounded' });
  assert.equal(r.code, 0, r.out);
  // the acceptance script is not run twice when it is also a daemon check
  assert.deepEqual(r.verdict.checks.map((c) => c.name), ['npm run test:mutation:grounded', 'test:changed']);
});

test('ORACLE_GATE_COMMAND and --cwd: the exports shape (npx vitest run … from packages/server)', () => {
  const dir = repo({ lint: ok });
  fs.mkdirSync(path.join(dir, 'pkg'));
  fs.writeFileSync(path.join(dir, 'pkg', 'a.test.mjs'), "import test from 'node:test'; test('t', () => {});\n");
  const r = gate(dir, ['--cwd', 'pkg'], { LOOP_DAEMON_CHECK_SCRIPTS: 'lint', ORACLE_GATE_COMMAND: 'node --test a.test.mjs' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.verdict.checks.map((c) => [c.name, c.exit]), [['node --test a.test.mjs', 0], ['lint', 0]]);
});

test('a daemon check missing from package.json is skipped, as in production', () => {
  const dir = repo({ 'test:accept': ok });
  const r = gate(dir, ['--', 'npm', 'run', 'test:accept'], { LOOP_DAEMON_CHECK_SCRIPTS: 'lint' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.verdict.checks[1], { name: 'lint', exit: null, ms: 0, skipped: 'not in package.json' });
});

test('a check over LOOP_DAEMON_CHECK_TIMEOUT_MS fails (timed out), as in production', () => {
  const dir = repo({ 'test:accept': ok, lint: 'node -e "setTimeout(()=>{},20000)"' });
  const r = gate(dir, ['--', 'npm', 'run', 'test:accept'], { LOOP_DAEMON_CHECK_SCRIPTS: 'lint', LOOP_DAEMON_CHECK_TIMEOUT_MS: '1000' });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.verdict.checks[1].timed_out, true);
  assert.match(r.out, /FAIL: lint/);
});

test('machine line contract (parsed by the server transcript scan): `ORACLE_GATE ` + one-line JSON {pass, checks, digest: sha256:<hex of the script>}', () => {
  for (const [script, pass] of [[ok, true], [bad, false]]) {
    const dir = repo({ 'test:accept': script });
    const r = gate(dir, ['--', 'npm', 'run', 'test:accept']);
    const lines = r.out.split('\n').filter((l) => l.startsWith('ORACLE_GATE '));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ORACLE_GATE \{"pass":(true|false),"checks":\[.*\],"digest":"sha256:[0-9a-f]{64}"\}$/);
    assert.deepEqual(Object.keys(r.verdict), ['pass', 'checks', 'digest']);
    assert.equal(r.verdict.pass, pass);
    assert.equal(r.verdict.digest, `sha256:${createHash('sha256').update(fs.readFileSync(SCRIPT)).digest('hex')}`);
  }
});

test('usage errors exit 2 and run nothing: unknown flag, no command, a command that is not a test/lint/type-check', () => {
  const marker = (dir) => fs.existsSync(path.join(dir, 'ran'));
  const touch = 'node -e "require(\'fs\').writeFileSync(\'ran\',\'\')"';
  for (const args of [['--no-such-flag', '--', 'npm', 'run', 'test:accept'], [], ['--', 'git', 'push', 'origin', 'HEAD'], ['--', 'npm', 'install'],
    ['--', 'npm', 'run', 'deploy'], ['--', 'npx', 'stryker', 'run'], ['--', 'npm', 'run', 'test:accept', ';', 'rm', '-rf', '.'], ['--', 'PATH=/tmp', 'npm', 'run', 'test:accept']]) {
    const dir = repo({ 'test:accept': touch, deploy: touch, lint: touch });
    const r = gate(dir, args, { LOOP_DAEMON_CHECK_SCRIPTS: 'lint' });
    assert.equal(r.code, 2, `${args.join(' ')}\n${r.out}`);
    assert.equal(r.verdict, null);
    assert.equal(marker(dir), false, `${args.join(' ')} ran something`);
  }
});

test('--doctor reports the configs and deps the oracle needs, installs nothing and changes no file', () => {
  const dir = repo({ 'test:changed': ok, lint: ok, 'type-check': ok, 'test:mutation:grounded': ok });
  fs.writeFileSync(path.join(dir, 'stryker.service.config.mjs'), 'export default {};\n');
  const before = fs.readdirSync(dir, { recursive: true }).sort();
  const r = gate(dir, ['--doctor'], CHECKS);
  assert.equal(r.code, 1, r.out); // node_modules is missing
  const line = r.out.split('\n').find((l) => l.startsWith('ORACLE_GATE_DOCTOR '));
  const doc = JSON.parse(line.slice('ORACLE_GATE_DOCTOR '.length));
  const item = (n) => doc.items.find((i) => i.name === n);
  assert.equal(doc.ok, false);
  assert.equal(item('stryker.service.config.mjs').present, true);
  assert.equal(item('vitest.service-mutation.config.ts').present, false);
  assert.equal(item('node_modules/.bin/vitest').present, false);
  assert.equal(item('script:lint').present, true);
  assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
  assert.doesNotMatch(r.out, /npm (ci|install)\b.*running|installing/i);
});
