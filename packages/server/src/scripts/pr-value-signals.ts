/**
 * re-20261105 B1: the auto-merge value gate's signal per loop PR, for scripts/merge-train.sh --value-signals (services/auto-merge-value-replay.ts prValueSignals).
 *   node dist/scripts/pr-value-signals.js --db <path> [--repo owner/name] > signals.json
 * Opens the database read-only and prints {"source", "repo", "generated_at", "kill_share_min", "prs": {"<n>": {"lane", "value_signal", "run_id"}}}.
 * Exit: 0 ok, 64 usage.
 */
import Database from 'better-sqlite3';
import { prValueSignals } from '../services/auto-merge-value-replay';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? '' : ''; };
const dbPath = arg('--db');
if (!dbPath) { console.error('usage: pr-value-signals --db <path> [--repo owner/name]'); process.exit(64); }
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
console.log(JSON.stringify(prValueSignals(db, arg('--repo') || process.env.GITHUB_REPOSITORY || 'djimit/djimitflo'), null, 2));
db.close();
