#!/usr/bin/env node
// FE-AREAS (operator 2026-10-06): turn Frontier Expert person identities into fields of interest and delete the people
// with their history. Dry-run by default (the transaction is rolled back after the report).
//   node scripts/fe-persons-to-areas.mjs --db /data/djimitflo.sqlite                      # dry-run, prints the report
//   node scripts/fe-persons-to-areas.mjs --db /data/djimitflo.sqlite --apply --backup /data/fe-areas-backup-<ts>.sqlite
// Runs against the compiled server (packages/server/dist). Never prints names.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.FE_AREAS_DIST || path.join(here, '..', 'packages', 'server', 'dist', 'services', 'expert-persons-migration.js');
const { migratePersonsToAreas, applyWithBackup } = require(dist);
const Database = require(require.resolve('better-sqlite3', { paths: [path.dirname(dist), process.cwd()] }));

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dbPath = arg('--db');
if (!dbPath) { console.error('usage: --db <path> [--apply --backup <path>]'); process.exit(2); }
const apply = args.includes('--apply');
const backup = arg('--backup');
if (apply && !backup) { console.error('--apply requires --backup <path>'); process.exit(2); }

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
try {
  const report = apply ? await applyWithBackup(db, backup) : migratePersonsToAreas(db, { apply: false });
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...(apply ? { backup } : {}), ...report }, null, 2));
} catch (error) {
  console.error(error.message, error.report ? JSON.stringify(error.report.check) : '');
  process.exit(1);
} finally {
  db.close();
}
