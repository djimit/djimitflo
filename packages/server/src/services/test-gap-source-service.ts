import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { SelfImprovementService } from './self-improvement-service';

/**
 * A deterministic, high-yield source of proposals: server services that no test imports. The 2026-09-21 loop proof showed
 * this class end to end (a test-only change, verified by one command, reviewed by a checker), while free-text "reflection"
 * proposals yielded 1 verified out of ~450. Every proposal is fully grounded (target file, runtime command, artifact, budget)
 * so the panel never has to ask for specifics. Default off: TEST_GAP_SOURCE_ENABLED=true.
 *   TEST_GAP_MAX_PER_DAY (default 2)   TEST_GAP_MAX_IN_FLIGHT (default 2)   TEST_GAP_REPO_PATH (default LOOP_DAEMON_REPOSITORY_PATH)
 */
export const testGapSourceEnabled = (): boolean => process.env.TEST_GAP_SOURCE_ENABLED === 'true';

export interface TestGap { service: string; sourcePath: string; testPath: string; exports: string[]; loc: number; kind?: 'untested' | 'exports' }

const SERVICES_DIR = 'packages/server/src/services';
const TESTS_DIR = 'packages/server/src/__tests__';
const MIN_LOC = 30; const MAX_LOC = 250;

export function discoverTestGaps(repoPath: string): TestGap[] {
  const servicesDir = path.join(repoPath, SERVICES_DIR); const testsDir = path.join(repoPath, TESTS_DIR);
  if (!fs.existsSync(servicesDir) || !fs.existsSync(testsDir)) return [];
  const tested = new Set<string>();
  for (const file of fs.readdirSync(testsDir).filter((f) => /\.test\.tsx?$/.test(f))) {
    const text = fs.readFileSync(path.join(testsDir, file), 'utf8');
    for (const m of text.matchAll(/\/services\/([A-Za-z0-9_-]+)(?:['"/])/g)) tested.add(m[1]);
    tested.add(file.replace(/\.test\.tsx?$/, '')); // a same-named test counts even if it imports indirectly
  }
  const gaps: TestGap[] = [];
  for (const file of fs.readdirSync(servicesDir).filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f))) {
    const service = file.replace(/\.ts$/, '');
    if (tested.has(service) || service === 'index') continue;
    const text = fs.readFileSync(path.join(servicesDir, file), 'utf8');
    const loc = text.split('\n').length;
    const exports = [...text.matchAll(/export\s+(?:async\s+)?(?:class|function|const)\s+(\w+)/g)].map((m) => m[1]).slice(0, 6);
    if (loc < MIN_LOC || loc > MAX_LOC || !exports.length) continue;
    gaps.push({ service, sourcePath: `${SERVICES_DIR}/${file}`, testPath: `packages/server/src/__tests__/${service}.test.ts`, exports, loc });
  }
  return gaps.sort((a, b) => a.loc - b.loc || a.service.localeCompare(b.service)); // smallest, most self-contained first
}

/**
 * J3: the second grounded lane. A service with tests can still export functions no test ever names. Same contract as a
 * test gap (one new test file, one command), so the loop's only working lane gets more work without new risk. The test
 * goes into a new `<service>.exports.test.ts`, never into an existing test file.
 */
const MAX_EXPORT_GAP_LOC = 600;
export function discoverExportGaps(repoPath: string): TestGap[] {
  const servicesDir = path.join(repoPath, SERVICES_DIR); const testsDir = path.join(repoPath, TESTS_DIR);
  if (!fs.existsSync(servicesDir) || !fs.existsSync(testsDir)) return [];
  const tests = fs.readdirSync(testsDir).filter((f) => /\.test\.tsx?$/.test(f)).map((f) => fs.readFileSync(path.join(testsDir, f), 'utf8'));
  const tested = new Set(tests.flatMap((t) => [...t.matchAll(/\/services\/([A-Za-z0-9_-]+)(?:['"/])/g)].map((m) => m[1])));
  const allTests = tests.join('\n');
  const gaps: TestGap[] = [];
  for (const file of fs.readdirSync(servicesDir).filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f))) {
    const service = file.replace(/\.ts$/, '');
    if (!tested.has(service)) continue; // untested services are discoverTestGaps' job
    const text = fs.readFileSync(path.join(servicesDir, file), 'utf8');
    const loc = text.split('\n').length;
    if (loc > MAX_EXPORT_GAP_LOC) continue;
    // One-line env-flag readers (`export const xEnabled = () => process.env.X === 'true'`) are not worth a loop run.
    const fns = [...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)[^\n]*|export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\([^\n]*/g)]
      .filter((m) => !m[0].includes('process.env')).map((m) => m[1] ?? m[2]);
    const untested = fns.filter((fn) => !new RegExp(`\\b${fn}\\b`).test(allTests)).slice(0, 3);
    if (!untested.length) continue;
    gaps.push({ service, sourcePath: `${SERVICES_DIR}/${file}`, testPath: `${TESTS_DIR}/${service}.exports.test.ts`, exports: untested, loc, kind: 'exports' });
  }
  return gaps.sort((a, b) => a.loc - b.loc || a.service.localeCompare(b.service));
}

/**
 * M2 (plan WS-M): the mutation-gap lane. A service with a same-named test can still let most mutants survive (prod
 * 2026-09-25: secret-patterns.test.ts, written by the loop, killed 31 % of them). The task is to strengthen that test;
 * fitness is measured in code by scripts/mutation-gain.mjs (Stryker on the committed vs the working-tree test, pass at
 * +10 points or >= 90). MUTATION_GAP_ENABLED=true (default off), MUTATION_GAP_MAX_PER_DAY (default 2), 1 in flight.
 */
export interface MutationGap { service: string; sourcePath: string; testPath: string; loc: number }
const MAX_MUTATION_LOC = 400;
const SENSITIVE = /(^|[-_])(auth|secrets?|deploy|token|credential|spawn)([-_]|$)/i;
export function discoverMutationGaps(repoPath: string): MutationGap[] {
  const servicesDir = path.join(repoPath, SERVICES_DIR); const testsDir = path.join(repoPath, TESTS_DIR);
  if (!fs.existsSync(servicesDir) || !fs.existsSync(testsDir)) return [];
  const gaps: MutationGap[] = [];
  for (const file of fs.readdirSync(servicesDir).filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f))) {
    const service = file.replace(/\.ts$/, '');
    if (SENSITIVE.test(service) || !fs.existsSync(path.join(testsDir, `${service}.test.ts`))) continue;
    const loc = fs.readFileSync(path.join(servicesDir, file), 'utf8').split('\n').length;
    if (loc < MIN_LOC || loc > MAX_MUTATION_LOC) continue;
    gaps.push({ service, sourcePath: `${SERVICES_DIR}/${file}`, testPath: `${TESTS_DIR}/${service}.test.ts`, loc });
  }
  return gaps.sort((a, b) => a.loc - b.loc || a.service.localeCompare(b.service));
}

/** MUTATE_FILE/MUTATE_TEST for the deterministic `test:mutation:grounded` check of a mutation-gap run, else {}. */
export function mutationCheckEnv(db: Database, goalId: string | null | undefined): Record<string, string> {
  if (!goalId) return {};
  const row = db.prepare(`SELECT s.evidence_refs_json AS refs, json_extract(s.grounding_json, '$.artifactPath') AS test
    FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?`).get(goalId) as { refs: string | null; test: string | null } | undefined;
  const service = row?.refs?.match(/"mutation-gap:([A-Za-z0-9_-]+)"/)?.[1];
  return service && row?.test ? { MUTATE_FILE: `${SERVICES_DIR}/${service}.ts`, MUTATE_TEST: row.test } : {};
}

export class TestGapSourceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database) {}

  start(intervalMs = 6 * 3600_000): void {
    if (this.timer || !testGapSourceEnabled()) return;
    const run = () => {
      try { const r = this.run(); if (r.created) console.log(`🧪 test-gap source: ${r.created} proposal(s) created`); } catch (err) { console.warn('Test-gap source failed:', err instanceof Error ? err.message : String(err)); }
      try { const r = this.runMutationGaps(); if (r.created) console.log(`🧬 mutation-gap source: ${r.created} proposal(s) created`); } catch (err) { console.warn('Mutation-gap source failed:', err instanceof Error ? err.message : String(err)); }
    };
    this.timer = setInterval(run, intervalMs); this.timer.unref?.();
    setTimeout(run, 90_000).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  run(now = new Date()): { created: number; skipped: string } {
    const repo = process.env.TEST_GAP_REPO_PATH || process.env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { created: 0, skipped: 'no repository path' };
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    const createdToday = (this.db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%test-gap:%' AND created_at >= ?").get(day) as { n: number }).n;
    const inFlight = (this.db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%test-gap:%' AND status IN ('proposed', 'scheduled', 'executing')").get() as { n: number }).n;
    const maxPerDay = Number(process.env.TEST_GAP_MAX_PER_DAY) || 2; const maxInFlight = Number(process.env.TEST_GAP_MAX_IN_FLIGHT) || 2;
    if (createdToday >= maxPerDay) return { created: 0, skipped: 'daily cap reached' };
    if (inFlight >= maxInFlight) return { created: 0, skipped: 'enough proposals in flight' };
    const improvements = new SelfImprovementService(this.db);
    let created = 0;
    // Untested services first, then untested exports of tested services (J3: TEST_GAP_EXPORTS_ENABLED).
    const gaps = [...discoverTestGaps(repo), ...(process.env.TEST_GAP_EXPORTS_ENABLED === 'true' ? discoverExportGaps(repo) : [])];
    for (const gap of gaps) {
      if (createdToday + created >= maxPerDay || inFlight + created >= maxInFlight) break;
      const ref = gap.kind === 'exports' ? `test-gap:${gap.service}#exports` : `test-gap:${gap.service}`;
      // a file that ever had a test-gap proposal of this kind (any outcome) is never proposed again automatically
      if (this.db.prepare("SELECT 1 FROM self_improvements WHERE evidence_refs_json LIKE ? LIMIT 1").get(`%${ref}"%`)) continue;
      const testFile = path.basename(gap.testPath);
      const command = `npx vitest run src/__tests__/${testFile}`;
      const budget = 'one maker lease, <= 10 minutes wall clock, <= 30k tokens, one checker lease; abort if any file other than the new test file changes';
      const covering = gap.kind === 'exports' ? `the untested exported functions ${gap.exports.join(', ')} of ${gap.sourcePath} (no existing test names them)` : `the public behaviour of ${gap.sourcePath} (exports: ${gap.exports.join(', ')})`;
      const description = `Add ${gap.testPath} covering ${covering}. Test-only; no production code edits. `
        + `RUNTIME COMMAND: from packages/server run \`${command}\` (exit 0 = pass, Node 22, no network, no env flags needed). `
        + `ARTIFACT: the vitest stdout captured by the worker, plus the git diff of the single new test file (expected < 150 lines added). BUDGET: ${budget}.`;
      const proposal = improvements.generateFromGroundedGap({
        title: gap.kind === 'exports' ? `Test untested exports of services/${gap.service}.ts` : `Add unit tests for services/${gap.service}.ts`, description,
        rationale: gap.kind === 'exports'
          ? `${gap.exports.join(', ')} in ${gap.sourcePath} are exported but no test names them; a test-only change is verifiable by one command`
          : `${gap.sourcePath} (${gap.loc} lines) is not imported by any test; a test-only change is verifiable by one command`,
        evidenceRef: ref,
        grounding: { target: gap.sourcePath, acceptanceTest: command, runtimeCommand: command, artifactPath: gap.testPath, budget },
      });
      if (proposal) created += 1;
    }
    return { created, skipped: created ? '' : 'no untested candidate' };
  }

  runMutationGaps(now = new Date()): { created: number; skipped: string } {
    if (process.env.MUTATION_GAP_ENABLED !== 'true') return { created: 0, skipped: 'disabled' };
    const repo = process.env.TEST_GAP_REPO_PATH || process.env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { created: 0, skipped: 'no repository path' };
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    const createdToday = (this.db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%mutation-gap:%' AND created_at >= ?").get(day) as { n: number }).n;
    const inFlight = (this.db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%mutation-gap:%' AND status IN ('proposed', 'scheduled', 'executing')").get() as { n: number }).n;
    if (createdToday >= (Number(process.env.MUTATION_GAP_MAX_PER_DAY) || 2)) return { created: 0, skipped: 'daily cap reached' };
    if (inFlight >= 1) return { created: 0, skipped: 'one in flight' };
    for (const gap of discoverMutationGaps(repo)) {
      const ref = `mutation-gap:${gap.service}`;
      if (this.db.prepare("SELECT 1 FROM self_improvements WHERE evidence_refs_json LIKE ? LIMIT 1").get(`%"${ref}"%`)) continue;
      const command = `MUTATE_FILE=${gap.sourcePath} MUTATE_TEST=${gap.testPath} npm run test:mutation:grounded`;
      const description = `Strengthen ${gap.testPath} so it kills more Stryker mutants of ${gap.sourcePath}. Edit only that test file; no production code edits. `
        + `RUNTIME COMMAND: from the repository root run \`${command}\` — it runs Stryker on the committed and on your version of the test and exits 0 `
        + `when the mutation score gains >= 10 points (or reaches 90). Its JSON line shows before/after; aim at the surviving mutants. `
        + 'ARTIFACT: the command output plus the diff of the one test file. BUDGET: one maker lease, <= 15 minutes, one checker lease.';
      const proposal = new SelfImprovementService(this.db).generateFromGroundedGap({
        title: `Raise the mutation score of services/${gap.service}.ts`, description,
        rationale: `${gap.testPath} exists, but a test that lets mutants survive does not guard behaviour; the gain is measured by one command`,
        evidenceRef: ref,
        grounding: { target: gap.testPath, acceptanceTest: command, runtimeCommand: command, artifactPath: gap.testPath, budget: 'one maker lease, <= 15 minutes, one checker lease' },
      });
      if (proposal) return { created: 1, skipped: '' };
    }
    return { created: 0, skipped: 'no candidate' };
  }
}
