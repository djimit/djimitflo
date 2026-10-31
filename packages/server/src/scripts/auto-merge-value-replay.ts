/**
 * C4 (re-20261030): operator-run, one-off replay of the auto-merge value gate on past auto-merges (services/auto-merge-value-replay.ts).
 *   node dist/scripts/auto-merge-value-replay.js --db <path> [--apply] [--rows]
 * Default is a DRY RUN: the database is opened read-only and only the summary is printed. --apply writes one shadow judgment
 * per past merge decision (replay: true; idempotent, a re-run writes nothing new). It never changes a decision or a flag.
 * Exit: 0 ok, 64 usage.
 */
import Database from 'better-sqlite3';
import { replayAutoMergeValueGate } from '../services/auto-merge-value-replay';

const i = process.argv.indexOf('--db'); const dbPath = i >= 0 ? process.argv[i + 1] : '';
if (!dbPath) { console.error('usage: auto-merge-value-replay --db <path> [--apply] [--rows]'); process.exit(64); }
const apply = process.argv.includes('--apply');
const db = new Database(dbPath, apply ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
const { rows, ...summary } = replayAutoMergeValueGate(db, { apply });
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...summary, ...(process.argv.includes('--rows') ? { rows } : {}) }, null, 2));
db.close();
