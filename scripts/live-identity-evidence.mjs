#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const base = process.env.DJIMITFLO_LIVE_URL || 'http://127.0.0.1:3001';
const dbPath = resolve(process.env.DJIMITFLO_DB || resolve(root, '.data/djimitflo.sqlite'));
const output = resolve(root, process.env.LIVE_IDENTITY_REPORT_PATH || 'openspec/changes/assurance-truth-closure/live-identity-evidence.json');

async function json(path) {
  try {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(5000),
      headers: process.env.DJIMITFLO_LIVE_AUTH_TOKEN ? { authorization: `Bearer ${process.env.DJIMITFLO_LIVE_AUTH_TOKEN}` } : {},
    });
    return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) };
  } catch (error) {
    return { status: null, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function command(name, args) {
  const result = spawnSync(name, args, { cwd: root, encoding: 'utf8', timeout: 5000 });
  return { ok: result.status === 0, exit_code: result.status, output: String(result.stdout || result.stderr).trim().slice(0, 1000) };
}

export function verifyIdentity({ health, version, provenance, integrity, commit, dirty, instanceId, instanceIdSource, localInstanceId }) {
  const database = provenance.body?.database;
  const databaseMatches = instanceIdSource === 'configured'
    || (instanceIdSource === 'local_database' && localInstanceId === instanceId && integrity.ok && integrity.output === 'ok');
  return Boolean(!dirty && /^[a-f0-9]{40}$/.test(commit)
    && health.ok && health.body?.status === 'healthy' && health.body?.commit === commit
    && version.ok && typeof version.body?.version === 'string' && version.body.version.length > 0
    && provenance.ok && database?.commit_sha === commit && database?.mode === 'live'
    && instanceId && databaseMatches && database?.instance_id === instanceId);
}

export function expectedDatabaseInstance({ baseUrl, configuredId, localInstanceId }) {
  if (configuredId?.trim()) return { instanceId: configuredId.trim(), source: 'configured' };
  try {
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(baseUrl).hostname)) {
      return { instanceId: localInstanceId, source: 'local_database' };
    }
  } catch {}
  return { instanceId: '', source: 'missing_explicit_configuration' };
}

async function main() {
const health = await json('/health');
const version = await json('/api/version');
const provenance = await json('/api/health/deep');
const integrity = existsSync(dbPath) ? command('sqlite3', ['-readonly', dbPath, 'PRAGMA integrity_check;']) : { ok: false, output: 'database missing' };
const instance = existsSync(dbPath) ? command('sqlite3', ['-readonly', dbPath, "SELECT value FROM system_state WHERE key = 'database_instance_id';"]) : { ok: false, output: '' };
const expectedDatabase = expectedDatabaseInstance({
  baseUrl: base,
  configuredId: process.env.DJIMITFLO_EXPECTED_DATABASE_INSTANCE_ID,
  localInstanceId: instance.ok ? instance.output : '',
});
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirtyState = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
const localInstanceId = instance.ok ? instance.output : '';
const identityVerified = verifyIdentity({ health, version, provenance, integrity, commit, dirty: Boolean(dirtyState), instanceId: expectedDatabase.instanceId, instanceIdSource: expectedDatabase.source, localInstanceId });
const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  status: identityVerified ? 'pass' : health.ok ? 'blocked' : 'fail',
  intended: { commit, dirty: Boolean(dirtyState), dirty_state_sha256: createHash('sha256').update(dirtyState).digest('hex'), database: dbPath, database_instance_id: expectedDatabase.instanceId || null, database_instance_id_source: expectedDatabase.source, local_database_instance_id: localInstanceId || null },
  observed: { base_url: base, health, version, authenticated_provenance: provenance, database_integrity: integrity },
  identity_verified: identityVerified,
  reason: identityVerified ? null : 'Deployment identity requires healthy authenticated provenance, matching full commit and database instance, live data mode, and a clean intended revision.',
  next_safe_action: expectedDatabase.source === 'missing_explicit_configuration'
    ? 'Set DJIMITFLO_EXPECTED_DATABASE_INSTANCE_ID from the deployment inventory before checking a remote target.'
    : expectedDatabase.source === 'local_database' && (localInstanceId !== expectedDatabase.instanceId || !integrity.ok || integrity.output !== 'ok')
      ? 'Point DJIMITFLO_DB at the intended loopback database and verify its integrity.'
    : provenance.status === 401
      ? 'Provide operator-authorized read:evidence authentication or run MCP doctor locally.'
      : 'Reconcile observed and intended runtime identity.',
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.status.toUpperCase()} ${output}`);
process.exitCode = report.status === 'pass' ? 0 : report.status === 'blocked' ? 2 : 1;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await main();
