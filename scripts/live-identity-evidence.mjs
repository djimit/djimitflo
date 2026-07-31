#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const base = process.env.DJIMITFLO_LIVE_URL || 'http://127.0.0.1:3001';
const dbPath = resolve(process.env.DJIMITFLO_DB || resolve(root, '.data/djimitflo.sqlite'));
const output = resolve(root, 'openspec/changes/assurance-truth-closure/live-identity-evidence.json');

async function json(path) {
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) });
    return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) };
  } catch (error) {
    return { status: null, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function command(name, args) {
  const result = spawnSync(name, args, { cwd: root, encoding: 'utf8', timeout: 5000 });
  return { ok: result.status === 0, exit_code: result.status, output: String(result.stdout || result.stderr).trim().slice(0, 1000) };
}

const health = await json('/health');
const version = await json('/api/version');
const provenance = await json('/api/swarms/runtime-readiness?runtime=codex');
const integrity = existsSync(dbPath) ? command('sqlite3', ['-readonly', dbPath, 'PRAGMA integrity_check;']) : { ok: false, output: 'database missing' };
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirtyState = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
const identityVerified = health.ok && version.ok && integrity.ok && integrity.output === 'ok' && provenance.ok && !dirtyState;
const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  status: identityVerified ? 'pass' : health.ok ? 'blocked' : 'fail',
  intended: { commit, dirty: Boolean(dirtyState), dirty_state_sha256: createHash('sha256').update(dirtyState).digest('hex'), database: dbPath },
  observed: { base_url: base, health, version, authenticated_provenance: provenance, database_integrity: integrity },
  identity_verified: identityVerified,
  reason: identityVerified ? null : 'Health is not deployment identity: authenticated provenance and a clean intended revision are required.',
  next_safe_action: provenance.status === 401 ? 'Provide operator-authorized read:evidence authentication or run MCP doctor locally.' : 'Reconcile observed and intended runtime identity.',
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.status.toUpperCase()} ${output}`);
process.exitCode = report.status === 'pass' ? 0 : report.status === 'blocked' ? 2 : 1;
