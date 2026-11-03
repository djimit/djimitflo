import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService, MAKER_TEMPLATE_RULES, makerTemplateRules } from '../services/loop-service';
import { LoopVerificationService } from '../services/loop-verification-service';
import { makerFailureClass } from '../services/outcome-attribution';
import { LoopDraftPrService } from '../services/loop-draft-pr-service';
import { checkLoopPrs, loopPrSettlements } from '../services/merge-survival';
import { runAutoMergeTick } from '../services/loop-auto-merge';
import { daemonCheckOptions } from '../services/loop-daemon';
import { MAKER_TEMPLATE_RULES_STE, steRulesFor } from '../services/ste-001';
import { TestGapSourceService, discoverNodeTestGaps } from '../services/test-gap-source-service';
import { SelfImprovementAgentReviewService } from '../services/self-improvement-agent-review-service';
import { extraRepoChecks, extraRepos, parsePrUrl, slugFromRemote } from '../services/repo-registry';

/**
 * Multi-repo oracle lanes (second-repo readiness 17-10): three integrity bugs fixed regardless of the flag (B1 vacuous check
 * pass, B2 draft PR to the wrong repo, B3 merge survival keyed by PR number alone), and EXTRA_REPOS_ENABLED (default off).
 */
const ROOT = path.resolve(__dirname, '../../../..');
let tmp: string; let db: Database.Database;
const fresh = () => { const d = new Database(':memory:'); d.pragma('foreign_keys = OFF'); d.exec(schema); runMigrations(d); return d; };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const write = (root: string, rel: string, text: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const now = new Date().toISOString();

/** A roborev-like plain ESM repo: one tested module with an untested export, one untested module, a CLI in bin/. */
function roborevFixture(root: string): string {
  const repo = path.join(root, 'roborev');
  const filler = '// line\n'.repeat(35);
  write(repo, 'package.json', JSON.stringify({ name: 'roborev', type: 'module', scripts: { test: 'node --test test/*.test.mjs' } }));
  write(repo, 'src/events.mjs', `export function normalizeEvent(e) { return e; }\nexport function validate(e) { return !!e; }\nexport function summarize(list) { return list.length; }\n${filler}`);
  write(repo, 'src/lib/dedupe.mjs', `export function dedupeKey(e) { return String(e.id); }\n${filler}`);
  write(repo, 'bin/roborev.mjs', `import { normalizeEvent } from '../src/events.mjs';\n${filler}`);
  write(repo, 'test/events.test.mjs', "import { test } from 'node:test';\nimport { normalizeEvent, validate } from '../src/events.mjs';\ntest('x', () => { normalizeEvent({}); validate({}); });\n");
  return repo;
}
const onEnv = (repo: string, extra: Record<string, string> = {}) => ({ EXTRA_REPOS_ENABLED: 'on', GITHUB_REPOSITORY: 'o/r', GITHUB_REPOSITORY_PATHS: JSON.stringify({ 'o/r': ROOT, 'djimit/roborev': repo }), ...extra }) as NodeJS.ProcessEnv;
const proposal = (id: string, refs: string[], target = 'src/x.mjs') => db.prepare(`INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, grounding_json, created_at, updated_at)
  VALUES (?, 'feature', 't', 'd', 'r', 'gap_analysis', 'verified', 0.6, ?, ?, ?, ?)`).run(id, JSON.stringify(refs), JSON.stringify({ target, artifactPath: 'test/x.test.mjs' }), now, now);
const goal = (id: string, improvementId: string) => db.prepare(`INSERT INTO goals (id, objective, risk_class, status, metadata, improvement_id, created_at, updated_at) VALUES (?, 'o', 'low', 'running', '{}', ?, ?, ?)`).run(id, improvementId, now, now);

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'multirepo-')); db = fresh(); });
afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('B1: a configured check script the repo does not have is a failure, never a vacuous pass', () => {
  function makerRun(scripts: Record<string, string>) {
    const wt = path.join(tmp, 'wt'); write(wt, 'package.json', JSON.stringify({ scripts }));
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('run', 'test-gap-loop', 'closed', 'running', '[]', '{}', '[]', '[]', '{"risk_class":"low"}', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, metadata, created_at, updated_at) VALUES ('m', 'run', 'maker', 'codex', 'completed', ?, '{}', ?, ?)`).run(wt, now, now);
    return new LoopService(db, path.join(tmp, 'evidence'));
  }

  it('a missing script fails the checks (reason missing_script) and blocks the run', () => {
    const loops = makerRun({ test: 'node -e "process.exit(0)"' });
    const result = loops.runDeterministicChecks('run', { lease_id: 'm', scripts: ['test', 'lint'] });
    expect(result.checks).toEqual([expect.objectContaining({ name: 'test', status: 'pass' }), expect.objectContaining({ name: 'lint', status: 'fail', reason: 'missing_script', exit_status: null })]);
    expect(result.run.status).toBe('blocked');
    expect(result.lease.metadata.failure_reason).toBe('deterministic_checks_failed:lint(missing_script)');
  });

  it('a run where no check executed and passed is not verified (all-skipped used to pass)', () => {
    const verify = new LoopVerificationService(makerRun({})) as unknown as { leaseChecksPassed(l: { metadata: Record<string, unknown> }): boolean };
    expect(verify.leaseChecksPassed({ metadata: { deterministic_checks: [{ name: 'test:assertion-strength', status: 'skipped', shadow_status: 'pass' }] } })).toBe(false);
    expect(verify.leaseChecksPassed({ metadata: { deterministic_checks: [{ name: 'lint', status: 'skipped' }] } })).toBe(false);
    expect(verify.leaseChecksPassed({ metadata: { deterministic_checks: [{ name: 'lint', status: 'pass' }, { name: 'test:assertion-strength', status: 'skipped' }] } })).toBe(true);
  });

  it('a missing script is an infrastructure failure, not a maker regression', () => {
    expect(makerFailureClass({ exit_status: 0, completed_at: now, changed_files: ['a.test.ts'], deterministic_checks: [{ exit_status: null, reason: 'missing_script' }] } as never)).toBe('infra_failed');
  });

  it("djimitflo has every script its check lists name, so prod behaviour is unchanged", () => {
    const scripts = Object.keys((JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts);
    // runDeterministicChecks default, prod LOOP_DAEMON_CHECK_SCRIPTS (+ the grounded lanes), proof runs
    for (const s of ['test', 'lint', 'type-check', 'test:changed', 'test:mutation:grounded', 'test:dead-code:grounded', 'proof:test', 'proof:lint', 'proof:type-check']) expect(scripts).toContain(s);
  });
});

describe('B2: a draft PR goes to the repo of the goal, or nowhere', () => {
  function draftRun(remoteUrl: string | null, refs: string[]) {
    const wt = path.join(tmp, 'wt'); const remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    execFileSync('git', ['init', '-q', '-b', 'main', wt]);
    write(wt, 'README.md', 'x\n'); git(wt, 'add', '.'); git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
    git(wt, 'remote', 'add', 'origin', remoteUrl ?? remote);
    write(wt, 'test/x.test.mjs', "import { test } from 'node:test';\ntest('x', () => {});\n");
    proposal('p1', refs); goal('g1', 'p1');
    db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, gates_json, created_at, updated_at) VALUES ('run-1', 'g1', 'test-gap-loop', 'closed', 'ready_for_human_merge', '[]', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, worktree_path, branch_name, metadata, created_at, updated_at) VALUES ('m1', 'run-1', 'maker', 'codex', 'completed', ?, 'agent/loop/run-1', '{}', ?, ?)`).run(wt, now, now);
    return remote;
  }
  const created = (slug: string) => vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ html_url: `https://github.com/${slug}/pull/3` }) });
  const failure = () => (db.prepare("SELECT message FROM loop_events WHERE event_type = 'draft_pr_failed'").get() as { message: string } | undefined)?.message;
  const base = { LOOP_AUTO_DRAFT_PR_ENABLED: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't0ken' };

  it('refuses (no push, no PR) when the worktree remote is another repo than the goal', async () => {
    draftRun('https://github.com/djimit/roborev.git', ['test-gap:x']);
    const f = created('o/r');
    expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, base).openForRun('run-1')).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(failure()).toBe('Draft PR not opened: repo_mismatch: worktree djimit/roborev ≠ goal o/r');
  });

  it('refuses a proposal for a repo that is not registered (flag off)', async () => {
    draftRun(null, ['test-gap:djimit/roborev/dedupe', 'repo:djimit/roborev']);
    const f = created('o/r');
    expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, base).openForRun('run-1')).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(failure()).toBe('Draft PR not opened: repo_not_registered: djimit/roborev');
  });

  it('flag on: the PR is opened against the proposal repo, not GITHUB_REPOSITORY', async () => {
    const repo = roborevFixture(tmp);
    const remote = draftRun(null, ['test-gap:djimit/roborev/dedupe', 'repo:djimit/roborev']);
    const f = created('djimit/roborev');
    expect(await new LoopDraftPrService(db, f as unknown as typeof fetch, { ...base, ...onEnv(repo) }).openForRun('run-1')).toBe('https://github.com/djimit/roborev/pull/3');
    expect(f.mock.calls[0][0]).toBe('https://api.github.com/repos/djimit/roborev/pulls');
    expect(git(remote, 'ls-tree', '-r', '--name-only', 'agent/loop/run-1')).toContain('test/x.test.mjs');
  });

  it('parses GitHub remotes and PR URLs, nothing else', () => {
    expect(slugFromRemote('git@github.com:djimit/roborev.git')).toBe('djimit/roborev');
    expect(slugFromRemote('https://x-access-token@github.com/djimit/djimitflo')).toBe('djimit/djimitflo');
    expect(slugFromRemote('/srv/repos/roborev')).toBeNull();
    expect(parsePrUrl('https://github.com/djimit/roborev/pull/7')).toEqual({ slug: 'djimit/roborev', number: 7 });
    expect(parsePrUrl('https://example.com/a/b/pull/7')).toBeNull();
  });
});

describe('B3: merge survival keys a PR by repo slug + number', () => {
  function twoRepos() {
    const run = (id: string, url: string) => {
      db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
        VALUES (?, 'test-gap-loop', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')`).run(id, JSON.stringify({ pr_url: url }));
      db.prepare("INSERT INTO worker_leases (id, loop_run_id, role, runtime, status, metadata, created_at, updated_at) VALUES (?, ?, 'maker', 'codex', 'completed', '{}', datetime('now'), datetime('now'))").run(`m-${id}`, id);
    };
    run('primary', 'https://github.com/o/r/pull/7'); run('other', 'https://github.com/djimit/roborev/pull/7');
  }
  // o/r #7 is merged long ago; djimit/roborev #7 was closed unmerged — the same number, different PRs
  const fetchImpl = vi.fn(async (url: string) => {
    const pr = url.includes('/repos/o/r/') ? { state: 'closed', merged_at: '2026-10-11T00:00:00Z', created_at: '2026-10-10T00:00:00Z' } : { state: 'closed', merged_at: null };
    if (/pulls\/7\/files/.test(url)) return { ok: true, status: 200, json: async () => [{ filename: 't.test.ts', patch: '@@\n+expect(add(1, 1)).toBe(2);' }] };
    if (/pulls\/7\/commits/.test(url)) return { ok: true, status: 200, json: async () => [] };
    if (/pulls\/7$/.test(url)) return { ok: true, status: 200, json: async () => pr };
    return { ok: true, status: 200, json: async () => ({ content: Buffer.from('expect(add(1, 1)).toBe(2);').toString('base64'), encoding: 'base64' }) };
  });
  const outcome = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(id) as { metadata: string }).metadata).pr_outcome;
  const NOW = new Date('2026-10-30T12:00:00Z');

  it('flag off: a PR of an unregistered repo is never polled, so never settled with the primary repo PR of the same number', async () => {
    twoRepos(); fetchImpl.mockClear();
    await checkLoopPrs(db, fetchImpl as unknown as typeof fetch, { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }, NOW);
    expect(fetchImpl.mock.calls.map((c) => c[0]).every((u) => String(u).startsWith('https://api.github.com/repos/o/r/'))).toBe(true);
    expect(outcome('primary')).toMatchObject({ state: 'merged', survived: true });
    expect(outcome('other')).toBeUndefined();
  });

  it('flag on: each PR is read from its own repo; the extra repo outcome stays out of loop-maker:% views', async () => {
    const repo = roborevFixture(tmp); twoRepos(); fetchImpl.mockClear();
    const env = { ...onEnv(repo), GITHUB_TOKEN: 't' };
    await checkLoopPrs(db, fetchImpl as unknown as typeof fetch, env, NOW);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toContain('https://api.github.com/repos/djimit/roborev/pulls/7');
    expect(outcome('primary')).toMatchObject({ state: 'merged', survived: true });
    expect(outcome('other')).toMatchObject({ state: 'closed_unmerged' });
    expect(db.prepare("SELECT task_id, skill_id, success FROM skill_outcomes WHERE domain = 'merge' ORDER BY task_id").all()).toEqual([
      { task_id: 'other', skill_id: 'repo:djimit/roborev:loop-maker:merge:codex', success: 0 }, { task_id: 'primary', skill_id: 'loop-maker:merge:codex', success: 1 }]);
    // repo dimension: the default view is the primary repo; a slug selects one repo
    expect(loopPrSettlements(db, NOW.getTime(), undefined, env).map((p) => p.run_id)).toEqual(['primary']);
    expect(loopPrSettlements(db, NOW.getTime(), 'djimit/roborev', env).map((p) => [p.run_id, p.repo])).toEqual([['other', 'djimit/roborev']]);
    expect(loopPrSettlements(db, NOW.getTime(), undefined, {}).map((p) => p.run_id).sort()).toEqual(['other', 'primary']); // flag off: unchanged
  });
});

it('auto-merge skips a repo that is not on LOOP_AUTO_MERGE_REPOS (default: the primary repo only) without calling GitHub', async () => {
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, metadata, created_at, updated_at) VALUES ('r', 'test-gap-loop', 'closed', 'completed', '[]', ?, ?, ?)`)
    .run(JSON.stringify({ pr_url: 'https://github.com/djimit/roborev/pull/7' }), now, now);
  const f = vi.fn();
  await runAutoMergeTick(db, f as unknown as typeof fetch, { LOOP_AUTO_MERGE_TEST_ONLY: 'act', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' }, new Date());
  expect(f).not.toHaveBeenCalled();
  expect(JSON.parse((db.prepare("SELECT metadata FROM loop_runs WHERE id = 'r'").get() as { metadata: string }).metadata).auto_merge)
    .toMatchObject({ decision: 'ineligible', reason: 'repo_not_allowed: djimit/roborev', pr_number: 7 });
});

describe('EXTRA_REPOS_ENABLED', () => {
  it('off (default): no extra repo exists, checks and the STE template are unchanged for djimitflo', () => {
    const repo = roborevFixture(tmp);
    const off = { ...onEnv(repo), EXTRA_REPOS_ENABLED: undefined } as NodeJS.ProcessEnv;
    expect(extraRepos(off)).toEqual([]);
    expect(extraRepos({ ...off, EXTRA_REPOS_ENABLED: 'shadow' })).toEqual([]);
    expect(daemonCheckOptions({ LOOP_DAEMON_CHECK_SCRIPTS: 'test:changed,lint' })).toEqual({ scripts: ['test:changed', 'lint'], timeout_ms: 120_000 });
    expect(makerTemplateRules({ arm: 1 })).toBe(MAKER_TEMPLATE_RULES_STE);
    expect(makerTemplateRules({ arm: 0 }, ['test'])).toBe(MAKER_TEMPLATE_RULES);
    expect(steRulesFor(['test:changed', 'lint', 'type-check'])).toEqual(MAKER_TEMPLATE_RULES_STE); // rule 12 is exactly today's text
  });

  it('off: the test-gap source creates nothing for a registered extra repo', () => {
    const repo = roborevFixture(tmp);
    vi.stubEnv('GITHUB_REPOSITORY_PATHS', JSON.stringify({ 'djimit/roborev': repo })); vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', ''); vi.stubEnv('TEST_GAP_REPO_PATH', '');
    expect(new TestGapSourceService(db).run()).toEqual({ created: 0, skipped: 'no repository path' });
  });

  it('discovers node:test gaps in a roborev-like repo: an untested module and the untested export of a tested one', () => {
    const repo = roborevFixture(tmp);
    expect(discoverNodeTestGaps(repo)).toEqual([
      { service: 'dedupe', sourcePath: 'src/lib/dedupe.mjs', testPath: 'test/dedupe.test.mjs', exports: ['dedupeKey'], loc: 37, command: 'node --test test/dedupe.test.mjs' },
      { service: 'events', sourcePath: 'src/events.mjs', testPath: 'test/events.exports.test.mjs', exports: ['summarize'], loc: 39, kind: 'exports', command: 'node --test test/events.exports.test.mjs' },
    ]);
  });

  /** A security-review-commons-like repo: ESM `.js` sources, tests in `tests/` as `*.test.js`. */
  function esmJsFixture(root: string, pkg: Record<string, unknown> | null): string {
    const repo = path.join(root, 'commons');
    const filler = '// line\n'.repeat(35);
    if (pkg) write(repo, 'package.json', JSON.stringify(pkg));
    write(repo, 'src/scan.js', `export function scan(t) { return [t]; }\nexport function dedupeFindings(f) { return f; }\n${filler}`);
    write(repo, 'src/report/summary.js', `export function summarize(f) { return f.length; }\n${filler}`);
    write(repo, 'src/legacy.cjs', `module.exports = { x: 1 };\nexport function notEsm() {}\n${filler}`);
    write(repo, 'tests/scan.test.js', "import { test } from 'node:test';\nimport { scan } from '../src/scan.js';\ntest('x', () => { scan('a'); });\n");
    return repo;
  }

  it('node:test lane: a tests/ dir with ESM .js sources when package.json has "type":"module" (command = node --test on the new file)', () => {
    const repo = esmJsFixture(tmp, { name: 'commons', type: 'module', scripts: { test: 'node --test' } });
    expect(discoverNodeTestGaps(repo)).toEqual([
      { service: 'summary', sourcePath: 'src/report/summary.js', testPath: 'tests/summary.test.js', exports: ['summarize'], loc: 37, command: 'node --test tests/summary.test.js' },
      { service: 'scan', sourcePath: 'src/scan.js', testPath: 'tests/scan.exports.test.js', exports: ['dedupeFindings'], loc: 38, kind: 'exports', command: 'node --test tests/scan.exports.test.js' },
    ]);
  });

  it('node:test lane: CommonJS .js stays out (no "type":"module", or no package.json); .mjs in tests/ still counts, .cjs never', () => {
    const mjsOnly = (pkg: Record<string, unknown> | null) => {
      fs.rmSync(path.join(tmp, 'commons'), { recursive: true, force: true });
      const repo = esmJsFixture(tmp, pkg);
      write(repo, 'src/util.mjs', `export const pick = (o) => o;\n${'// line\n'.repeat(35)}`);
      return discoverNodeTestGaps(repo).map((g) => g.sourcePath);
    };
    expect(mjsOnly({ name: 'commons', type: 'commonjs' })).toEqual(['src/util.mjs']);
    expect(mjsOnly({ name: 'commons' })).toEqual(['src/util.mjs']);
    expect(mjsOnly(null)).toEqual(['src/util.mjs']);
  });

  it('node:test lane: a .mjs module in a tests/ repo keeps its .mjs test; an existing <name>.exports.test.js suppresses the exports gap', () => {
    const repo = esmJsFixture(tmp, { name: 'commons', type: 'module' });
    write(repo, 'src/util.mjs', `export const pick = (o) => o;\n${'// line\n'.repeat(35)}`);
    write(repo, 'tests/scan.exports.test.js', "import { test } from 'node:test';\ntest('x', () => {});\n");
    expect(discoverNodeTestGaps(repo).map((g) => [g.sourcePath, g.testPath, g.command])).toEqual([
      ['src/report/summary.js', 'tests/summary.test.js', 'node --test tests/summary.test.js'],
      ['src/util.mjs', 'tests/util.test.mjs', 'node --test tests/util.test.mjs'],
    ]);
  });

  it('shadow records what it would propose and creates nothing; on creates grounded repo-tagged proposals', () => {
    const repo = roborevFixture(tmp);
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r'); vi.stubEnv('GITHUB_REPOSITORY_PATHS', JSON.stringify({ 'djimit/roborev': repo }));
    vi.stubEnv('LOOP_DAEMON_REPOSITORY_PATH', ''); vi.stubEnv('TEST_GAP_REPO_PATH', ''); vi.stubEnv('TEST_GAP_MAX_PER_DAY', '5'); vi.stubEnv('TEST_GAP_MAX_IN_FLIGHT', '5');
    vi.stubEnv('EXTRA_REPOS_ENABLED', 'shadow');
    new TestGapSourceService(db).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM self_improvements').get()).toEqual({ n: 0 });
    expect(JSON.parse((db.prepare("SELECT answers_json FROM judgments WHERE judgment = 'extra_repo_test_gaps'").get() as { answers_json: string }).answers_json))
      .toEqual([{ repo: 'djimit/roborev', gaps: ['src/lib/dedupe.mjs', 'src/events.mjs#exports'] }]);

    vi.stubEnv('EXTRA_REPOS_ENABLED', 'on');
    expect(new TestGapSourceService(db).run().created).toBe(2);
    const rows = db.prepare('SELECT evidence_refs_json AS refs, grounding_json AS g FROM self_improvements ORDER BY created_at, id').all() as Array<{ refs: string; g: string }>;
    expect(rows.map((r) => JSON.parse(r.refs)).sort()).toEqual([['test-gap:djimit/roborev/dedupe', 'repo:djimit/roborev'], ['test-gap:djimit/roborev/events#exports', 'repo:djimit/roborev']].sort());
    expect(rows.map((r) => JSON.parse(r.g).runtimeCommand).sort()).toEqual(['node --test test/dedupe.test.mjs', 'node --test test/events.exports.test.mjs']);
    expect(new TestGapSourceService(db).run().created).toBe(0); // never twice
  });

  it('on: per-repo checks, panel excerpt from the proposal repo, STE rule 12 names the repo scripts', () => {
    const repo = roborevFixture(tmp);
    expect(extraRepoChecks('djimit/roborev', {})).toEqual(['test']);
    expect(extraRepoChecks('djimit/roborev', { EXTRA_REPO_CHECKS_DJIMIT_ROBOREV: 'test, lint' })).toEqual(['test', 'lint']);
    expect(daemonCheckOptions({ LOOP_DAEMON_CHECK_SCRIPTS: 'test:changed,lint' }, { slug: 'djimit/roborev', path: repo })).toEqual({ scripts: ['test'], timeout_ms: 120_000 });
    expect(makerTemplateRules({ arm: 1 }, ['test'])).toContain('12. Before you stop, run `npm run test`.');
    vi.stubEnv('EXTRA_REPOS_ENABLED', 'on'); vi.stubEnv('GITHUB_REPOSITORY', 'o/r'); vi.stubEnv('GITHUB_REPOSITORY_PATHS', JSON.stringify({ 'djimit/roborev': repo }));
    vi.stubEnv('REVIEW_EVIDENCE_REPO_PATH', ROOT);
    const review = new SelfImprovementAgentReviewService(db) as unknown as { targetEvidence(p: { context: unknown }): string | null };
    expect(review.targetEvidence({ context: { grounding: { target: 'src/lib/dedupe.mjs' }, evidence_refs: ['test-gap:djimit/roborev/dedupe', 'repo:djimit/roborev'] } })).toContain('export function dedupeKey');
    expect(review.targetEvidence({ context: { grounding: { target: 'src/lib/dedupe.mjs' }, evidence_refs: ['test-gap:dedupe'] } })).toBeNull(); // primary repo: not there
  });
});
