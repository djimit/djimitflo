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

export interface TestGap { service: string; sourcePath: string; testPath: string; exports: string[]; loc: number }

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

export class TestGapSourceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database) {}

  start(intervalMs = 6 * 3600_000): void {
    if (this.timer || !testGapSourceEnabled()) return;
    const run = () => { try { const r = this.run(); if (r.created) console.log(`🧪 test-gap source: ${r.created} proposal(s) created`); } catch (err) { console.warn('Test-gap source failed:', err instanceof Error ? err.message : String(err)); } };
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
    for (const gap of discoverTestGaps(repo)) {
      if (createdToday + created >= maxPerDay || inFlight + created >= maxInFlight) break;
      // a file that ever had a test-gap proposal (any outcome) is never proposed again automatically
      if (this.db.prepare("SELECT 1 FROM self_improvements WHERE evidence_refs_json LIKE ? LIMIT 1").get(`%test-gap:${gap.service}"%`)) continue;
      const command = `npx vitest run src/__tests__/${gap.service}.test.ts`;
      const budget = 'one maker lease, <= 10 minutes wall clock, <= 30k tokens, one checker lease; abort if any file other than the new test file changes';
      const description = `Add ${gap.testPath} covering the public behaviour of ${gap.sourcePath} (exports: ${gap.exports.join(', ')}). Test-only; no production code edits. `
        + `RUNTIME COMMAND: from packages/server run \`${command}\` (exit 0 = pass, Node 22, no network, no env flags needed). `
        + `ARTIFACT: the vitest stdout captured by the worker, plus the git diff of the single new test file (expected < 150 lines added). BUDGET: ${budget}.`;
      const proposal = improvements.generateFromGroundedGap({
        title: `Add unit tests for services/${gap.service}.ts`, description,
        rationale: `${gap.sourcePath} (${gap.loc} lines) is not imported by any test; a test-only change is verifiable by one command`,
        evidenceRef: `test-gap:${gap.service}`,
        grounding: { target: gap.sourcePath, acceptanceTest: command, runtimeCommand: command, artifactPath: gap.testPath, budget },
      });
      if (proposal) created += 1;
    }
    return { created, skipped: created ? '' : 'no untested candidate' };
  }
}
