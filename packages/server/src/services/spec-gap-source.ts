import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { SENSITIVE_SERVICE } from './gym-task-miner';
import { WRITE_TEST_ORACLE, targetMutants, type FailureTask } from './gym-failure-tasks';

/**
 * SPEC_GAP_LANE (off | shadow | on, default off): OpenSpec scenarios without a test become 'write_test' gym tasks.
 * Source: openspec/specs/<capability>/spec.md of the target checkout (`### Requirement:` blocks with `#### Scenario:`
 * GIVEN/WHEN/THEN bullets). A scenario is covered when some test file names it — its title (case-insensitive) or its
 * stable id `spec:<capability>/<slug>` — deterministic, no LLM. An uncovered scenario becomes a task only when its
 * requirement mentions a file path that exists, is a worker-valid write_test target (a server service), is not
 * sensitive, and has at least one seeded mutant (same targetMutants as the failure tasks); the oracle is the existing
 * WRITE_TEST_ORACLE (green on the real target AND kills >= 1 mutant). Key `spec:<sha12(capability + scenario)>`.
 * The scenario text is carried verbatim as DATA (`instructions.role = 'data'`), never as an instruction.
 * shadow: the test-gap source records a `judgments` row `spec_gap_tasks` (counts only). on: `specGapPoolTasks` is the
 * hook the gym claim can offer AFTER TG-001 and trial pairs; spec keys are never holdout keys (`isSpecGapKey`).
 * ponytail: the gym claim (remote-gym-service, TG-001 frozen surface) does not call the hook yet — wiring needs an
 * operator-approved TG-surface change; the worker's write_test prompt also does not read `instructions` yet.
 */
export type SpecGapMode = 'off' | 'shadow' | 'on';
export const specGapMode = (env: NodeJS.ProcessEnv = process.env): SpecGapMode => {
  const v = String(env.SPEC_GAP_LANE ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'on' ? v : 'off';
};

export interface SpecScenario { title: string; text: string }
export interface SpecRequirement { title: string; text: string; scenarios: SpecScenario[] }
export interface SpecGapTask extends Omit<FailureTask, 'run_id' | 'lane'> {
  lane: 'spec-gap';
  spec: { capability: string; requirement: string; scenario: string; id: string };
  instructions: { role: 'data'; text: string };
}

/** Parses one spec.md: each `### Requirement:` with its `#### Scenario:` blocks (text verbatim, trimmed). */
export function parseSpec(markdown: string): SpecRequirement[] {
  const reqs: SpecRequirement[] = []; let req: SpecRequirement | null = null; let sc: SpecScenario | null = null;
  const lines: string[] = [];
  const flush = () => { if (sc) { sc.text = lines.join('\n').trim(); sc = null; } else if (req) req.text = lines.join('\n').trim(); lines.length = 0; };
  for (const line of markdown.split('\n')) {
    const r = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line); const s = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line);
    if (r) { flush(); req = { title: r[1], text: '', scenarios: [] }; reqs.push(req); continue; }
    if (s && req) { flush(); sc = { title: s[1], text: '' }; req.scenarios.push(sc); continue; }
    if (/^#{1,3}\s/.test(line)) { flush(); req = null; continue; } // another section ends the requirement
    if (req) lines.push(line);
  }
  flush();
  return reqs;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const scenarioId = (capability: string, scenario: string) => `spec:${capability}/${slug(scenario)}`;
export const specTaskKey = (capability: string, scenario: string) => `spec:${createHash('sha256').update(`${capability}\n${scenario}`).digest('hex').slice(0, 12)}`;
export const isSpecGapKey = (key: string | null | undefined): boolean => /^spec:[0-9a-f]{12}$/.test(String(key ?? ''));

/** Covered: some test file names the scenario title (case-insensitive) or its stable id. */
export const scenarioCovered = (capability: string, title: string, testCorpus: string): boolean =>
  testCorpus.includes(scenarioId(capability, title)) || testCorpus.toLowerCase().includes(title.toLowerCase());

const PATH_MENTION = /[\w@.-]+(?:\/[\w@.-]+)+\.[cm]?[jt]sx?\b/g;
const TARGET = /^packages\/server\/src\/services\/([A-Za-z0-9_-]+)\.ts$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const MAX_SCENARIO_CHARS = 4000;

/** The checkout as read at one base commit (injectable for tests). */
export interface SpecRepo { base: string | null; files: string[]; read(file: string): string | null }
export function specRepo(repo: string): SpecRepo {
  let base: string | null = null; let files: string[] = [];
  try { base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || null; } catch { base = null; }
  try { files = execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }).split('\n').filter(Boolean); } catch { files = []; }
  return { base, files, read: (f) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return null; } } };
}

export interface SpecGapScan { scenarios: number; covered: number; uncovered: number; unanchored: number; anchored_without_mutant: number; tasks: SpecGapTask[] }

/** Deterministic scan: every scenario classified; tasks for uncovered, anchored, mutable scenarios (sorted by key). */
export function scanSpecGaps(src: SpecRepo): SpecGapScan {
  const out: SpecGapScan = { scenarios: 0, covered: 0, uncovered: 0, unanchored: 0, anchored_without_mutant: 0, tasks: [] };
  const fileSet = new Set(src.files);
  const testCorpus = src.files.filter((f) => TEST_FILE.test(f) && !f.includes('node_modules/')).map((f) => src.read(f) ?? '').join('\n');
  const specs = src.files.filter((f) => /^openspec\/specs\/[^/]+(?:\/[^/]+)*\/spec\.md$/.test(f)).sort();
  const mutantCache = new Map<string, ReturnType<typeof targetMutants> | null>();
  for (const file of specs) {
    const capability = path.posix.dirname(file).slice('openspec/specs/'.length);
    for (const req of parseSpec(src.read(file) ?? '')) {
      const whole = [req.title, req.text, ...req.scenarios.flatMap((s) => [s.title, s.text])].join('\n');
      const anchors = [...new Set(whole.match(PATH_MENTION) ?? [])].filter((p) => fileSet.has(p) && TARGET.test(p) && !SENSITIVE_SERVICE.test(TARGET.exec(p)![1]));
      for (const sc of req.scenarios) {
        out.scenarios++;
        if (scenarioCovered(capability, sc.title, testCorpus)) { out.covered++; continue; }
        out.uncovered++;
        if (!anchors.length || !src.base || !/^[0-9a-f]{7,40}$/.test(src.base) || sc.text.length > MAX_SCENARIO_CHARS) { out.unanchored++; continue; }
        const key = specTaskKey(capability, sc.title);
        let picked: { target: string; original: string; mutants: ReturnType<typeof targetMutants> } | null = null;
        for (const target of anchors) {
          if (!mutantCache.has(target)) { const original = src.read(target); mutantCache.set(target, original ? targetMutants(original, src.base, target) : null); }
          const mutants = mutantCache.get(target);
          if (mutants?.length) { picked = { target, original: src.read(target)!, mutants }; break; }
        }
        if (!picked) { out.anchored_without_mutant++; continue; }
        const test = `packages/server/src/__tests__/${TARGET.exec(picked.target)![1]}.spec-${key.slice(5)}.test.ts`;
        if (fileSet.has(test)) { out.covered++; out.uncovered--; continue; }
        out.tasks.push({ commit: key, kind: 'write_test', base: src.base, source: test, tests: [test], target: picked.target, sourceLines: picked.original.split('\n').length,
          mutants: picked.mutants, oracle: WRITE_TEST_ORACLE, lane: 'spec-gap',
          spec: { capability, requirement: req.title, scenario: sc.title, id: scenarioId(capability, sc.title) },
          instructions: { role: 'data', text: sc.text } });
      }
    }
  }
  out.tasks.sort((a, b) => a.commit.localeCompare(b.commit));
  return out;
}

/**
 * The single hook for the gym task pool (on only): untried, non-holdout spec tasks, to be offered AFTER TG-001 tasks and
 * trial pairs under the same caps. off / shadow → [] (shadow never acts).
 */
export function specGapPoolTasks(src: SpecRepo, exclude: Set<string | null>, env: NodeJS.ProcessEnv = process.env): SpecGapTask[] {
  if (specGapMode(env) !== 'on') return [];
  return scanSpecGaps(src).tasks.filter((t) => !exclude.has(t.commit));
}

/** shadow | on: one `judgments` row `spec_gap_tasks` with the counts (a row only when the counts changed). Never acts. */
export function recordSpecGapShadow(db: Database, src: SpecRepo, now = new Date(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (specGapMode(env) === 'off') return false;
  try {
    const { tasks, ...counts } = scanSpecGaps(src);
    const answers = { ...counts, tasks: tasks.length, base: src.base, keys: tasks.map((t) => t.commit), targets: [...new Set(tasks.map((t) => t.target))] };
    const hash = createHash('sha256').update(JSON.stringify(answers)).digest('hex').slice(0, 16);
    const last = db.prepare("SELECT state_hash FROM judgments WHERE judgment = 'spec_gap_tasks' ORDER BY created_at DESC LIMIT 1").get() as { state_hash: string } | undefined;
    if (last?.state_hash === hash) return false;
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'spec_gap_tasks', 'openspec', 'spec-gap', ?, 'shadow', 'recorded', ?, ?, ?)`)
      .run(randomUUID(), hash, `${tasks.length} task(s) from ${counts.uncovered}/${counts.scenarios} uncovered scenario(s)`, JSON.stringify(answers), now.toISOString());
    return true;
  } catch { return false; /* evidence only */ }
}

/** Evidence (nested under failure_tasks): the latest recorded scan; null when nothing was recorded (unknown, not zero). */
export function specGapEvidence(db: Database, env: NodeJS.ProcessEnv = process.env) {
  let last: { answers_json: string; created_at: string } | undefined;
  try { last = db.prepare("SELECT answers_json, created_at FROM judgments WHERE judgment = 'spec_gap_tasks' ORDER BY created_at DESC LIMIT 1").get() as typeof last; } catch { last = undefined; }
  let latest: Record<string, unknown> | null = null;
  try { latest = last ? { ...JSON.parse(last.answers_json), at: last.created_at } : null; } catch { latest = null; }
  return { mode: specGapMode(env), latest, served: null as number | null,
    note: 'shadow counts only; on = specGapPoolTasks hook, not yet wired into the gym claim (TG-001 surface, operator OK needed) — served stays null until then' };
}
