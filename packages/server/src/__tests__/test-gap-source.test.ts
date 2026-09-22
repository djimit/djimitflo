import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TestGapSourceService, discoverTestGaps } from '../services/test-gap-source-service';

let db: Database.Database; let repo: string;
const body = (n: number, exp = 'export class X {}') => `${exp}\n${'// filler\n'.repeat(n)}`;
const write = (rel: string, text: string) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-'));
  write('packages/server/src/services/alpha.ts', body(40, 'export function alpha() {}'));            // untested, in range
  write('packages/server/src/services/beta.ts', body(60, 'export class Beta {}'));                   // untested, larger
  write('packages/server/src/services/gamma.ts', body(50, 'export const gamma = 1;'));               // tested (imported)
  write('packages/server/src/services/tiny.ts', 'export const t = 1;\n');                            // too small
  write('packages/server/src/services/huge.ts', body(400));                                          // too large
  write('packages/server/src/services/noexports.ts', body(60, 'const hidden = 1;'));                 // nothing to test
  write('packages/server/src/__tests__/gamma.test.ts', "import { gamma } from '../services/gamma';\n");
  process.env.LOOP_DAEMON_REPOSITORY_PATH = repo; process.env.PROPOSAL_GROUNDING_REQUIRED = 'true';
});
afterEach(() => { delete process.env.LOOP_DAEMON_REPOSITORY_PATH; delete process.env.PROPOSAL_GROUNDING_REQUIRED; delete process.env.TEST_GAP_MAX_PER_DAY; db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

it('finds untested, mid-sized services that export something, smallest first', () => {
  expect(discoverTestGaps(repo).map((g) => g.service)).toEqual(['alpha', 'beta']);
  expect(discoverTestGaps(repo)[0]).toMatchObject({ testPath: 'packages/server/src/__tests__/alpha.test.ts', exports: ['alpha'] });
});
it('creates fully grounded proposals (they pass the grounding gate), never twice for the same file, within the daily cap', () => {
  process.env.TEST_GAP_MAX_PER_DAY = '1';
  const svc = new TestGapSourceService(db);
  expect(svc.run().created).toBe(1);
  const row = db.prepare("SELECT status, description, source FROM self_improvements").get() as { status: string; description: string; source: string };
  expect(row).toMatchObject({ status: 'proposed', source: 'gap_analysis' }); // grounded => reaches the panel, not parked as needs_grounding
  expect(row.description).toContain('RUNTIME COMMAND'); expect(row.description).toContain('src/__tests__/alpha.test.ts');
  expect(svc.run().skipped).toBe('daily cap reached');
  process.env.TEST_GAP_MAX_PER_DAY = '5';
  expect(svc.run().created).toBe(1); // beta next; alpha is never proposed again
  expect(svc.run().created).toBe(0);
});
