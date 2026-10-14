/**
 * Holdout epoch 1: operator-run manifest freeze (never automatic; see docs/runbooks/self-improvement-loop-operations.md).
 *   node dist/scripts/holdout-freeze.js --db <path> --manifest <file> --epoch <n> --expect-sha <sha256> --repo <checkout>
 *     [--species atomic@llama-router] [--operator <name>] [--p0 0.37 --p1 0.57 --alpha 0.05 --icc 0.1] [--apply]
 * Default is a DRY RUN: the database is opened read-only and every check runs (schema, sha256, size, eligibility NOW,
 * occupied epoch); nothing is written. --apply migrates, freezes the epoch in one transaction and appends a hash-chained
 * audit event (holdout.freeze) inside it. It never sets DREAM_EVOLUTION_ENABLED or GYM_HOLDOUT_EPOCH and starts nothing.
 * The power report (exact one-sided McNemar, paired) uses the stated assumptions; it is printed, never used to size.
 * Exit: 0 frozen / valid dry run, 2 refused, 3 hold, 64 usage.
 * Build mode (read-only, writes only --out): --build --out <file> --epoch <n> --size <n> --tiers 3,4,5,6 --repo <checkout>
 *   [--base <manifest>] — the same exclusions as the freeze; keeps the base's still-eligible tasks, refills mined.
 */
import fs from 'fs';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { runMigrations } from '../database/migrate';
import { buildHoldoutManifest, freezeHoldoutFromManifest } from '../services/holdout-manifest';
import { pairedPowerReport } from '../services/holdout-power';
import { mineGymTasks } from '../services/gym-task-miner';
import { failureDerivedTasks, gitLookup } from '../services/gym-failure-tasks';
import { mutantTask } from '../services/gym-mutants';
import { ComplianceAuditService } from '../services/compliance-audit-service';

const arg = (name: string, fallback = '') => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const [dbPath, manifestPath, epochRaw, expect, repo] = [arg('db'), arg('manifest'), arg('epoch'), arg('expect-sha'), arg('repo')];
const git = (args: string[]) => { try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
if (process.argv.includes('--build')) {
  const out = arg('out'); const size = Number(arg('size', '20')); const tiers = arg('tiers', '3,4,5,6').split(',').map(Number);
  const maxPerSource = arg('max-per-source') ? Number(arg('max-per-source')) : undefined;
  if (!dbPath || !out || !repo || !/^\d+$/.test(epochRaw)) { console.error('usage: holdout-freeze --build --db <path> --out <file> --epoch <n> --size <n> --tiers 3,4 --repo <checkout> [--base <manifest>]'); process.exit(64); }
  const bdb = new Database(dbPath, { readonly: true, fileMustExist: true });
  const base = arg('base') ? JSON.parse(fs.readFileSync(arg('base'), 'utf8')) as Record<string, unknown> : undefined;
  const built = buildHoldoutManifest(bdb, { epoch: Number(epochRaw), size, tiers, base, maxPerSource, pool: { mined: mineGymTasks(repo), writeTest: failureDerivedTasks(bdb, gitLookup(repo)) },
    provenance: { origin_sha: git(['rev-parse', 'HEAD']), builder: 'holdout-freeze --build' } });
  bdb.close();
  fs.writeFileSync(out, JSON.stringify(built.manifest, null, 1) + '\n');
  console.log(JSON.stringify({ out, manifest_sha256: built.manifest.manifest_sha256, dropped: built.dropped, added: built.added, notes: built.notes, shortfall: built.shortfall }, null, 2));
  process.exit(built.shortfall ? 3 : 0);
}
if (!dbPath || !manifestPath || !/^\d+$/.test(epochRaw) || !/^[0-9a-f]{64}$/.test(expect) || !repo) {
  console.error('usage: holdout-freeze --db <path> --manifest <file> --epoch <n> --expect-sha <sha256> --repo <checkout> [--apply]'); process.exit(64);
}
const apply = process.argv.includes('--apply');
const species = arg('species', 'atomic@llama-router');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

const db = new Database(dbPath, apply ? {} : { readonly: true, fileMustExist: true });
if (apply) { db.pragma('foreign_keys = ON'); runMigrations(db); }
const audit = apply ? new ComplianceAuditService(db) : null;
const result = freezeHoldoutFromManifest(db, manifest, {
  epoch: Number(epochRaw), expectedSha256: expect, dryRun: !apply, operator: arg('operator', process.env.USER || 'operator'),
  pool: { mined: mineGymTasks(repo), writeTest: failureDerivedTasks(db, gitLookup(repo)) },
  makeMutant: (tier, tried) => mutantTask(db, repo, species, tried, tier),
  origin: { sha: process.env.DJIMITFLO_BUILD_SHA?.trim() || git(['rev-parse', 'HEAD']), version: process.env.npm_package_version || null },
  onFrozen: (record) => audit?.appendEntry({ actor: record.operator ?? 'operator', action: 'holdout.freeze', resource: `holdout_epoch:${record.epoch}`, outcome: 'success',
    evidence: { manifest_sha256: record.manifest_sha256, counts: record.counts, origin_sha: record.origin_sha, holdout_size: record.holdout_size },
    event: { eventType: 'holdout.freeze', resourceType: 'gym_holdout', riskLevel: 'high', after: { epoch: record.epoch, keys: record.keys } } }),
});
// task families (same source file) of the DECIDING set: the generated mutants when the manifest declares them deciding
const tasks = (manifest.tasks ?? {}) as { mined?: Array<{ source: string }> };
const policy = (manifest.evaluation_policy ?? {}) as { deciding?: string };
const frozenKeys = result.status === 'FROZEN' || result.status === 'VALID_DRY_RUN' ? result.keys : null;
const familySources = policy.deciding === 'mutant' && frozenKeys ? frozenKeys.mutant.map((k) => k.split(':')[2]) : (tasks.mined ?? []).map((t) => t.source);
const families = new Map<string, number>(); for (const f of familySources) families.set(f, (families.get(f) ?? 0) + 1);
const size = result.status === 'FROZEN' || result.status === 'VALID_DRY_RUN' ? result.holdout_size : (tasks.mined ?? []).length;
const power = pairedPowerReport({ n: size, p0: Number(arg('p0', '0.37')), p1: Number(arg('p1', '0.57')), alpha: Number(arg('alpha', '0.05')),
  clusterSizes: [...families.values()], icc: Number(arg('icc', '0.1')) });
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', result, power_report: { note: 'assumptions, not measurements; never used to size the holdout',
  deciding: policy.deciding ?? 'mined', families: families.size, family_sizes: [...families.values()].sort((a, b) => b - a), ...power } }, null, 2));
db.close();
process.exit(result.status === 'REFUSED' ? 2 : result.status === 'HOLD' ? 3 : 0);
