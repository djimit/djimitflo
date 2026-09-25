/**
 * Expert Resolution Benchmark runner (§43–§45): `npx tsx src/scripts/expert-resolution-benchmark.ts [--json] [--k 3]`.
 * Runs offline on an in-memory database with the synthetic fixture; prints the markdown comparison and hard gates.
 */
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { renderMarkdown, runBenchmark } from '../services/expert-resolution-benchmark';

const args = process.argv.slice(2);
const k = Number(args[args.indexOf('--k') + 1] || 3) || 3;
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(schema);
runMigrations(db);
const report = runBenchmark(db, { k });
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(renderMarkdown(report));
  console.log('\n| query | kind | expected | frontier selected (capabilities) | baseline selected (state) |\n|---|---|---|---|---|');
  report.outcomes.frontier.forEach((outcome, index) => {
    const base = report.outcomes.baseline[index];
    console.log(`| ${outcome.id} | ${outcome.kind} | ${outcome.expected.join(', ') || '—'} | ${outcome.abstained ? 'abstained' : outcome.selected.map((expert) => expert.capabilities.join('+')).join('; ')} | ${base.abstained ? 'abstained' : base.selected.map((expert) => `${expert.capabilities.join('+') || 'none'}/${expert.lifecycle_state}`).join('; ')} |`);
  });
}
process.exit(report.gates.passed ? 0 : 1);
