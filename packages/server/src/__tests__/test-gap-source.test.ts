import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { TestGapSourceService, discoverExportGaps, discoverMutationGaps, discoverTestGaps, mutationCheckEnv } from '../services/test-gap-source-service';

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
  write('packages/server/src/services/orphan.ts', body(40, 'export function orphan() {}'));          // untested, but dead code
  // N12a: production code imports every service above except orphan
  write('packages/server/src/index.ts', ['alpha', 'beta', 'gamma', 'tiny', 'huge', 'noexports'].map((n) => `import * as ${n} from './services/${n}';`).join('\n'));
  process.env.LOOP_DAEMON_REPOSITORY_PATH = repo; process.env.PROPOSAL_GROUNDING_REQUIRED = 'true';
});
afterEach(() => { delete process.env.LOOP_DAEMON_REPOSITORY_PATH; delete process.env.PROPOSAL_GROUNDING_REQUIRED; delete process.env.TEST_GAP_MAX_PER_DAY; delete process.env.MUTATION_GAP_ENABLED; db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

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

it('J3: finds exported functions of tested services that no test names, and proposes them behind TEST_GAP_EXPORTS_ENABLED', () => {
  write('packages/server/src/services/gamma.ts', `export const gamma = 1;\nexport function covered() {}\nexport function orphanA() {}\nexport const orphanB = async (x: number) => x;\nexport const flagEnabled = (): boolean => process.env.FLAG === 'true';\n${'// filler\n'.repeat(40)}`); // flag readers are skipped
  write('packages/server/src/__tests__/gamma.test.ts', "import { gamma, covered } from '../services/gamma';\ncovered();\n");
  expect(discoverExportGaps(repo)).toEqual([expect.objectContaining({ service: 'gamma', kind: 'exports', exports: ['orphanA', 'orphanB'],
    testPath: 'packages/server/src/__tests__/gamma.exports.test.ts' })]);
  process.env.TEST_GAP_MAX_PER_DAY = '5'; process.env.TEST_GAP_MAX_IN_FLIGHT = '5';
  const svc = new TestGapSourceService(db);
  expect(svc.run().created).toBe(2); // alpha + beta only: the export lane is off by default
  process.env.TEST_GAP_EXPORTS_ENABLED = 'true';
  try {
    expect(svc.run().created).toBe(1);
    const row = db.prepare("SELECT title, description, evidence_refs_json FROM self_improvements WHERE title LIKE 'Test untested exports%'").get() as Record<string, string>;
    expect(row.title).toBe('Test untested exports of services/gamma.ts');
    expect(row.description).toContain('src/__tests__/gamma.exports.test.ts');
    expect(row.evidence_refs_json).toContain('test-gap:gamma#exports');
    expect(svc.run().created).toBe(0); // never twice
  } finally { delete process.env.TEST_GAP_EXPORTS_ENABLED; delete process.env.TEST_GAP_MAX_IN_FLIGHT; }
});

it('M2: mutation gaps are tested, mid-sized, non-sensitive services; one grounded proposal at a time, and its check gets MUTATE_*', () => {
  write('packages/server/src/services/token-vault.ts', body(50)); write('packages/server/src/__tests__/token-vault.test.ts', '// t');
  expect(discoverMutationGaps(repo).map((g) => g.service)).toEqual(['gamma']); // alpha/beta untested, token-vault sensitive
  const svc = new TestGapSourceService(db);
  expect(svc.runMutationGaps().skipped).toBe('disabled');
  process.env.MUTATION_GAP_ENABLED = 'true';
  expect(svc.runMutationGaps().created).toBe(1);
  const row = db.prepare("SELECT id, status, description FROM self_improvements WHERE evidence_refs_json LIKE '%mutation-gap:gamma%'").get() as { id: string; status: string; description: string };
  expect(row.status).toBe('proposed');
  expect(row.description).toContain('MUTATE_FILE=packages/server/src/services/gamma.ts MUTATE_TEST=packages/server/src/__tests__/gamma.test.ts npm run test:mutation:grounded');
  expect(svc.runMutationGaps().skipped).toBe('one in flight');
  db.prepare("INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES ('g', 'o', 'low', 'running', '{}', ?, datetime('now'), datetime('now'))").run(row.id);
  expect(mutationCheckEnv(db, 'g')).toEqual({ MUTATE_FILE: 'packages/server/src/services/gamma.ts', MUTATE_TEST: 'packages/server/src/__tests__/gamma.test.ts' });
  expect(mutationCheckEnv(db, null)).toEqual({});
});

it('N12a: a service no production file imports is dead code: no test lane proposes work on it', () => {
  expect(discoverTestGaps(repo).map((g) => g.service)).not.toContain('orphan');
  write('packages/server/src/routes/x.ts', "import { orphan } from '../services/orphan';");
  expect(discoverTestGaps(repo).map((g) => g.service)).toContain('orphan');
});
