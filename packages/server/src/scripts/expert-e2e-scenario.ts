/** §59 reference scenario runner: `npx tsx src/scripts/expert-e2e-scenario.ts` (scripted fake model, offline). */
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { renderScenario, runReferenceScenario } from '../services/expert-e2e-scenario';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(schema);
runMigrations(db);
runReferenceScenario(db).then((report) => { console.log(renderScenario(report)); process.exit(report.passed ? 0 : 1); });
