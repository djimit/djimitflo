import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import { assessAssertionStrength, ASSERTION_STRENGTH_CHECK, weakAssertionCheckMode, WEAK_SHARE_MAX } from '../services/test-assertion-strength';

// F1 experiment 09-10: the LLM checker accepted 3/7 diffs whose matchers were swapped for toBeDefined() (kind B); it
// rejected every diff with the assertions removed (A) or the target import dropped (C). The fixtures model those kinds.
const TARGET = 'packages/server/src/services/widget.ts';
const TEST = 'packages/server/src/__tests__/widget.exports.test.ts';
const GOOD = `import { describe, expect, it } from 'vitest';
import { widgetMode, parseWidget } from '../services/widget';

describe('widget', () => {
  it('defaults to off', () => { expect(widgetMode({})).toBe('off'); });
  it('reads shadow', () => { expect(widgetMode({ WIDGET: 'shadow' })).toBe('shadow'); expect(widgetMode({ WIDGET: 'x' })).not.toBe('shadow'); });
  it('parses', () => { expect(parseWidget('a,b')).toEqual(['a', 'b']); expect(parseWidget('')).toBeDefined(); });
  it.each([['1', 1], ['2', 2]])('number %s', (s, n) => { expect(Number(s)).toBe(n); });
});
`;
const KIND_A = GOOD.replace(/expect\([^;]*;/g, ''); // assertions removed
const KIND_B = GOOD.replace(/\)\.(?:not\.)?(?:toBe|toEqual)\([^)]*\)\)?;/g, ').toBeDefined();'); // matchers swapped for toBeDefined
const KIND_C = GOOD.replace("import { widgetMode, parseWidget } from '../services/widget';", 'const widgetMode: any = () => 1; const parseWidget: any = () => 1;'); // target import dropped
const assess = (text: string, target: string | null = TARGET) => assessAssertionStrength([{ path: TEST, text }], target);

describe('assessAssertionStrength (pre-registered thresholds)', () => {
  it('a normal test passes and reports its metrics', () => {
    const r = assess(GOOD);
    expect(r.status).toBe('pass');
    expect(r.reasons).toEqual([]);
    expect(r.files).toEqual([{ path: TEST, expects: 6, weak: 1, weak_share: 0.167, tests: 4, assertions_per_test: 1.5, target_imported: true }]);
  });

  it('kind A (no expect) fails on 0 assertions', () => {
    const r = assess(KIND_A);
    expect(KIND_A).not.toContain('expect(widget');
    expect(r.status).toBe('fail');
    expect(r.reasons).toContain(`${TEST}: 0 expect() assertions`);
  });

  it('kind B (matchers swapped for toBeDefined) fails on the weak-matcher share', () => {
    const r = assess(KIND_B);
    expect(r.status).toBe('fail');
    expect(r.files[0]).toMatchObject({ expects: 6, weak: 6, weak_share: 1 });
    expect(r.reasons).toContain(`${TEST}: weak-matcher share 1 > ${WEAK_SHARE_MAX}`);
  });

  it('kind C (target import dropped) fails on the missing target import', () => {
    const r = assess(KIND_C);
    expect(r.status).toBe('fail');
    expect(r.files[0].target_imported).toBe(false);
    expect(r.reasons).toEqual([`no changed test file imports the target ${TARGET}`]);
  });

  it('counts every weak matcher form; a type-only import or vi.mock is not an import of the target', () => {
    const text = `import type { W } from '../services/widget';\nvi.mock('../services/widget');\nit('w', () => { expect(a).toBeTruthy(); expect(b).toBeFalsy(); expect(c).not.toBeUndefined(); expect(d).toBeInstanceOf(Object); expect(e).toBeInstanceOf(Map); expect(f).toBeUndefined(); });\n`;
    const r = assess(text);
    expect(r.files[0]).toMatchObject({ expects: 6, weak: 4, tests: 1, target_imported: false });
    expect(assess("const m = await import('../services/widget.js');\nit('w', () => { expect(m.x).toBe(1); });\n").files[0].target_imported).toBe(true);
  });

  it('without an in-process parser (prod image) it measures in a child node with the worktree typescript, else skips', () => {
    const repo = path.resolve(__dirname, '../../../..'); // has the root workspace's typescript 6
    for (const text of [GOOD, KIND_A, KIND_B, KIND_C]) {
      expect(assessAssertionStrength([{ path: TEST, text }], TARGET, { parser: null, worktree: repo })).toEqual(assess(text));
    }
    expect(assessAssertionStrength([{ path: TEST, text: GOOD }], TARGET, { parser: null, worktree: os.tmpdir() }))
      .toEqual({ status: 'skipped', reasons: ['typescript parser unavailable'], target: TARGET, files: [] });
  });

  it('an unknown target only skips the import criterion', () => {
    expect(assess(GOOD, null)).toMatchObject({ status: 'pass', files: [{ target_imported: null }] });
  });

  it('WEAK_ASSERTION_CHECK_MODE defaults to off', () => {
    expect(weakAssertionCheckMode({})).toBe('off');
    expect(weakAssertionCheckMode({ WEAK_ASSERTION_CHECK_MODE: 'shadow' })).toBe('shadow');
    expect(weakAssertionCheckMode({ WEAK_ASSERTION_CHECK_MODE: 'enforce' })).toBe('enforce');
    expect(weakAssertionCheckMode({ WEAK_ASSERTION_CHECK_MODE: 'bogus' })).toBe('off');
  });
});

describe('runDeterministicChecks: test:assertion-strength', () => {
  let db: Database.Database; let worktree: string; let bin: string; let loops: LoopService; const PATH = process.env.PATH;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-strength-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-npm-'));
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // every script passes
    process.env.PATH = `${bin}:${PATH}`;
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ scripts: { 'test:changed': 'vitest run' } }));
    fs.mkdirSync(path.join(worktree, 'packages/server/src/__tests__'), { recursive: true });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
      VALUES ('p', 'feature', 't', 'd', 'r', 'gap_analysis', 'executing', 0.5, ?, ?, ?, ?)`).run(JSON.stringify(['test-gap:widget#exports']), JSON.stringify({ artifactPath: TEST, target: TARGET }), now, now);
    db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES ('g', 'o', 'low', 'running', '{}', 'p', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, goal_id, created_at, updated_at)
      VALUES ('r', 'test-gap', 'closed', 'running', '[]', '{}', '[]', '[]', '{}', 'g', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, metadata, created_at, updated_at)
      VALUES ('l', 'r', 'maker', 'codex', 'completed', ?, ?, ?, ?)`).run(worktree, JSON.stringify({ changed_files: [TEST] }), now, now);
    loops = new LoopService(db, fs.mkdtempSync(path.join(os.tmpdir(), 'assert-strength-ev-')));
  });
  afterEach(() => { vi.unstubAllEnvs(); process.env.PATH = PATH; db.close(); fs.rmSync(worktree, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); });
  const run = (text: string) => { fs.writeFileSync(path.join(worktree, TEST), text); return loops.runDeterministicChecks('r', { lease_id: 'l', scripts: ['test:changed'] }); };
  const checkOf = (r: ReturnType<typeof run>) => r.checks.find((c) => c.name === ASSERTION_STRENGTH_CHECK) as Record<string, unknown> | undefined;

  it('off (default) adds no check', () => {
    const r = run(KIND_B);
    expect(checkOf(r)).toBeUndefined();
    expect(r.run.status).toBe('verifying');
  });

  it('shadow records the failing verdict and reasons for reviewers but never fails the run', () => {
    vi.stubEnv('WEAK_ASSERTION_CHECK_MODE', 'shadow');
    const r = run(KIND_B);
    const check = checkOf(r)!;
    expect(check).toMatchObject({ mode: 'shadow', status: 'skipped', shadow_status: 'fail' });
    expect(check.reasons).toEqual([`${TEST}: weak-matcher share 1 > ${WEAK_SHARE_MAX}`]);
    expect(fs.readFileSync(String(check.stdout_path), 'utf8')).toContain('weak-matcher share 1');
    expect(r.lease.status).toBe('completed');
    expect(r.run.status).toBe('verifying');
    // the reviewer prompt's check summary (#716) shows the shadow verdict
    expect((loops as unknown as { checkResultsForReviewer(raw: unknown): string }).checkResultsForReviewer(r.lease.metadata.deterministic_checks))
      .toContain(`### ${ASSERTION_STRENGTH_CHECK}: shadow fail`);
  });

  it('enforce adds a failing check to the gates and blocks the run; a strong test passes', () => {
    vi.stubEnv('WEAK_ASSERTION_CHECK_MODE', 'enforce');
    const bad = run(KIND_A);
    expect(checkOf(bad)).toMatchObject({ mode: 'enforce', status: 'fail' });
    expect(bad.lease.status).toBe('failed');
    expect(bad.run.status).toBe('blocked');
    expect(String(bad.lease.metadata.failure_reason)).toContain(ASSERTION_STRENGTH_CHECK);
  });

  it('enforce passes a normal test', () => {
    vi.stubEnv('WEAK_ASSERTION_CHECK_MODE', 'enforce');
    const good = run(GOOD);
    expect(checkOf(good)).toMatchObject({ mode: 'enforce', status: 'pass' });
    expect(good.run.status).toBe('verifying');
  });

  it('a non test-writing lane gets no check', () => {
    vi.stubEnv('WEAK_ASSERTION_CHECK_MODE', 'enforce');
    db.prepare("UPDATE self_improvements SET evidence_refs_json = ? WHERE id = 'p'").run(JSON.stringify(['doc-drift:README.md']));
    expect(checkOf(run(KIND_A))).toBeUndefined();
  });
});
