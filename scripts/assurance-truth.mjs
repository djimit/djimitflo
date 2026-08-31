#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, process.env.ASSURANCE_REPORT_PATH || 'openspec/changes/assurance-truth-closure/evidence.json');
const now = new Date().toISOString();
const gates = [];

function hashFile(path) {
  return createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
}

function run(id, command, args, { mandatory = true, env = {} } = {}) {
  const started_at = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  gates.push({
    id,
    mandatory,
    status: result.status === 0 ? 'pass' : result.status === 2 ? 'blocked' : 'fail',
    exit_code: result.status,
    started_at,
    finished_at: new Date().toISOString(),
    evidence: redact(combined).slice(-4000),
  });
}

function redact(value) {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,"']+/gi, '$1[REDACTED]');
}

function source(command, args) {
  try { return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function sourceState() {
  const status = source('git', ['status', '--porcelain=v1']) || '';
  const hash = createHash('sha256').update(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root }));
  const untracked = (source('git', ['ls-files', '--others', '--exclude-standard']) || '').split('\n').filter(Boolean);
  for (const path of untracked) hash.update(path).update('\0').update(readFileSync(resolve(root, path)));
  return { commit: source('git', ['rev-parse', 'HEAD']), dirty: Boolean(status), dirty_state_sha256: hash.digest('hex') };
}

function main() {
  const initialSource = sourceState();
  const major = Number(process.versions.node.split('.')[0]);
  gates.push({
  id: 'supported_node',
  mandatory: true,
  status: major >= 20 && major < 25 ? 'pass' : 'fail',
  evidence: `node=${process.version}; required=>=20 <25`,
  started_at: now,
  finished_at: now,
  });

  if (process.argv.includes('--full')) {
    run('tests', 'npm', ['test']);
    run('type_check', 'npm', ['run', 'type-check']);
    run('lint', 'npm', ['run', 'lint']);
    run('build', 'npm', ['run', 'build']);
  }
  run('dependency_audit', 'npm', ['run', 'audit:ci']);
  run('contract_inventory', 'npm', ['run', 'assurance:contracts']);
  run('openmythos_evidence', 'npm', ['run', 'assurance:openmythos']);
  run('integration_probes', 'npm', ['run', 'assurance:integrations']);
  run('live_identity', 'npm', ['run', 'assurance:live']);
  run('diff_check', 'git', ['diff', '--check']);

  const mandatory = gates.filter(gate => gate.mandatory);
  const status = mandatory.some(gate => gate.status === 'fail') ? 'fail'
    : mandatory.some(gate => gate.status === 'blocked') ? 'blocked' : 'pass';
  const report = {
  schema_version: 1,
  status,
  generated_at: now,
  source: {
    ...initialSource,
    package_lock_sha256: hashFile('package-lock.json'),
  },
  environment: { node: process.version, npm: source('npm', ['--version']) },
  gates,
  limitations: status === 'pass' ? [] : ['At least one mandatory local gate did not pass.'],
  next_safe_action: status === 'pass' ? 'Run read-only integration and live identity certification.' : 'Resolve the first failed mandatory gate.',
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${status.toUpperCase()} ${output}`);
  process.exitCode = status === 'pass' ? 0 : 1;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();

export { redact };
