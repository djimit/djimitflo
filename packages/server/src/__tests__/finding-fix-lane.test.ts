import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FindingFixSourceService, findingFixCheck, findingFixCheckEnv, findingFixMode, FINDING_FIX_DIFF_MAX } from '../services/finding-fix-source';
import { oracleLaneSkipsPanel } from '../services/self-improvement-service';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';

const SCRIPT = path.resolve(__dirname, '../../../../scripts/finding-fix-gate.mjs');
const S = 'packages/server/src';
const TARGET = `${S}/services/paths.ts`;
type Found = { id: string; rule: string; line: number; occurrence: number };
type Gate = {
  GAMING_LINE: Array<[string, RegExp]>;
  loadScanner: (env?: NodeJS.ProcessEnv) => Promise<{ error?: string; version?: string }>;
  makeLinter: (scanner: unknown, root: string) => { packSha: string; scan: (text: string, file: string) => Promise<{ findings?: Found[]; error?: string }> };
  evaluateGate: (i: Record<string, unknown>) => { pass: boolean; reasons: string[] };
};
const gate = async () => (await import('../../../../scripts/finding-fix-gate.mjs')) as unknown as Gate;

let repo: string; let db: Database.Database;
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, encoding: 'utf8' });
// two no-useless-escape findings (lines 1, 2) and one preserve-caught-error (line 4)
const BASE = [
  "export const JSON_FILE = 'credentials\\.json';",
  "export const KEY_FILE = 'secret\\.key';",
  'export function load(read: () => string): string {',
  "  try { return read(); } catch (err) { throw new Error('load failed'); }",
  '}',
  '',
].join('\n');

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-fix-'));
  write('tsconfig.json', '{}\n');
  write(TARGET, BASE);
  write(`${S}/services/clean.ts`, 'export const x = 1;\n');
  write(`${S}/__tests__/paths.test.ts`, "const fixture = 'a\\.b';\n"); // a test file is never a candidate
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'base');
  db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db);
});
afterEach(() => { db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, TEST_GAP_REPO_PATH: repo, ...extra });
const runGate = (vars: Record<string, string>) => spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, ...vars } });
const verdict = (stdout: string) => JSON.parse(stdout.trim().split('\n').pop()!).finding_fix_gate as { pass: boolean; reasons: string[]; gaming_hits: string[] };

async function scanOf(text: string) {
  const g = await gate();
  const linter = g.makeLinter(await g.loadScanner({}), repo);
  return { linter, findings: (await linter.scan(text, TARGET)).findings! };
}
async function inputsFor(rule: string, index = 0) {
  const { linter, findings } = await scanOf(BASE);
  const f = findings.filter((x) => x.rule === rule)[index];
  return { FINDING_FIX_ID: f.id, FINDING_FIX_RULE: rule, FINDING_FIX_FILE: TARGET, FINDING_FIX_PACK: linter.packSha };
}

describe('finding ids (scripts/finding-fix-gate.mjs)', () => {
  it('are stable when unrelated lines shift the finding down, and distinguish identical lines by occurrence', async () => {
    const before = (await scanOf(BASE)).findings;
    expect(before.map((f) => f.rule)).toEqual(['no-useless-escape', 'no-useless-escape', 'preserve-caught-error']);
    const shifted = (await scanOf(`// header\n\nimport os from 'node:os';\nvoid os;\n${BASE}`)).findings;
    expect(shifted.map((f) => f.id)).toEqual(before.map((f) => f.id));
    expect(shifted.map((f) => f.line)).toEqual(before.map((f) => f.line + 4));
    const twice = (await scanOf(`${BASE}export const JSON_FILE2 = 'credentials\\.json';\nexport const JSON_FILE3 = 'credentials\\.json';\n`)).findings;
    const dup = twice.filter((f) => f.rule === 'no-useless-escape' && f.line > 5);
    expect(dup.map((f) => f.occurrence)).toEqual([0, 0]); // different line text → each its own first occurrence
    // identical flagged lines: occurrence 0 and 1, so two ids
    const same = (await scanOf("export const P = [\n  'x\\.y',\n  'x\\.y',\n];\n")).findings;
    expect(same.map((f) => f.occurrence)).toEqual([0, 1]);
    expect(new Set(same.map((f) => f.id)).size).toBe(2);
  });
});

describe('finding-fix gate on a real worktree', () => {
  it('passes a one-file fix that removes the finding and fails a reworded line that keeps it (count rule)', async () => {
    const inputs = await inputsFor('no-useless-escape');
    write(TARGET, BASE.replace("'credentials\\.json'", "'credentials.json'"));
    const ok = runGate(inputs);
    expect(verdict(ok.stdout)).toMatchObject({ pass: true });
    expect(ok.status).toBe(0);
    // reworded: the flagged line's text (so its id) changes, but the useless escape stays
    write(TARGET, BASE.replace("export const JSON_FILE = 'credentials\\.json';", "export const JSON_PATH = 'credentials\\.json';"));
    const reworded = runGate(inputs);
    expect(reworded.status).toBe(1);
    const v = verdict(reworded.stdout);
    expect(v.reasons.join('\n')).toContain('count in packages/server/src/services/paths.ts did not drop: 2 → 2');
    expect(v.reasons.join('\n')).toContain('new pack finding');
  });

  it('rejects a suppression comment even though inline config is ignored, and a new finding of another rule', async () => {
    const inputs = await inputsFor('no-useless-escape');
    write(TARGET, BASE.replace("export const JSON_FILE", "// eslint-disable-next-line no-useless-escape\nexport const JSON_FILE"));
    const r = runGate(inputs);
    expect(r.status).toBe(1);
    expect(verdict(r.stdout).reasons).toEqual(expect.arrayContaining(['gaming:eslint-suppression', 'target finding still present']));
    write(TARGET, BASE.replace("'credentials\\.json'", "'credentials.json'").replace('export const KEY_FILE', "export const DOT = '\\.';\nexport const KEY_FILE"));
    expect(verdict(runGate(inputs).stdout).reasons.join()).toContain('new pack finding');
  });

  it('rejects an extra modified file, an added file and a deleted target', async () => {
    const inputs = await inputsFor('no-useless-escape');
    write(TARGET, BASE.replace("'credentials\\.json'", "'credentials.json'"));
    write(`${S}/services/clean.ts`, 'export const x = 2;\n');
    expect(verdict(runGate(inputs).stdout).reasons.join()).toContain(`changed outside the target file: M ${S}/services/clean.ts`);
    git('checkout', '--', `${S}/services/clean.ts`);
    write(`${S}/services/new.ts`, 'export const y = 1;\n');
    expect(verdict(runGate(inputs).stdout).reasons.join()).toContain(`changed outside the target file: A ${S}/services/new.ts`);
    fs.rmSync(path.join(repo, `${S}/services/new.ts`));
    fs.rmSync(path.join(repo, TARGET));
    const gone = verdict(runGate(inputs).stdout);
    expect(gone.pass).toBe(false);
    expect(gone.reasons.join()).toContain('target file deleted');
  });

  it('fails (never skips) on a missing scanner, a missing input or a changed pack; is a no-op only with no input at all', async () => {
    const inputs = await inputsFor('preserve-caught-error');
    write(TARGET, BASE.replace("throw new Error('load failed');", "throw new Error('load failed', { cause: err });"));
    expect(runGate(inputs).status).toBe(0);
    const noScanner = runGate({ ...inputs, FINDING_FIX_ESLINT_FROM: path.join(repo, 'nowhere') });
    expect(noScanner.status).toBe(1);
    expect(verdict(noScanner.stdout).reasons.join()).toContain('scanner_missing');
    const noPack = runGate({ ...inputs, FINDING_FIX_PACK: '' });
    expect(noPack.status).toBe(1);
    expect(verdict(noPack.stdout).reasons.join()).toContain('missing input: FINDING_FIX_PACK');
    expect(verdict(runGate({ ...inputs, FINDING_FIX_PACK: '0000000000000000' }).stdout).reasons.join()).toContain('pack changed');
    const none = runGate({});
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('skipped (no FINDING_FIX_ID)');
  });

  it('enforces the 30 changed / 15 removed line caps', async () => {
    const inputs = await inputsFor('no-useless-escape');
    write(TARGET, BASE.replace("'credentials\\.json'", "'credentials.json'") + Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
    expect(verdict(runGate(inputs).stdout).reasons.join()).toContain('diff too large');
  });
});

describe('finding-fix gate anti-gaming (pure)', () => {
  const clean = { id: 'a', rule: 'no-useless-escape', file: 'f.ts', pack: 'p', actualPack: 'p', statuses: [{ status: 'M', path: 'f.ts' }], numstat: [{ path: 'f.ts', added: 1, removed: 1 }],
    before: [{ id: 'a', rule: 'no-useless-escape', line: 1 }], after: [] };
  const added: Record<string, string> = {
    'eslint-suppression': '// eslint-disable-line', 'eslint-inline-config': '/* eslint no-useless-escape: 0 */', 'eslint-env-globals': '/* globals foo */',
    'ts-suppression': '// @ts-expect-error nope', 'scanner-suppression': 'x(); // NOSONAR', 'security-review-suppression': '// security-review: ignore',
    'coverage-pragma': '/* istanbul ignore next */', 'test-skip': "it.skip('x', () => {})", 'node-test-skip': "test('x', { skip: true }, () => {})",
  };
  it('passes the clean diff', async () => {
    expect((await gate()).evaluateGate({ ...clean, added: ["const a = 'x.y';"] })).toMatchObject({ pass: true, reasons: [] });
  });
  it.each(Object.entries(added))('rejects %s', async (name, line) => {
    const g = await gate();
    expect(g.GAMING_LINE.map(([n]) => n)).toContain(name);
    expect(g.evaluateGate({ ...clean, added: [line] }).reasons).toContain(`gaming:${name}`);
  });
  it('rejects every scanner/test-skip variant from the design list', async () => {
    const g = await gate();
    for (const line of ['// eslint-disable', '/* eslint-enable */', '// eslint-disable-next-line', '// @ts-ignore', '// @ts-nocheck', '# nosec', '// nosemgrep', '// lgtm[js/x]', '// codeql[js/x]', '/* c8 ignore next */', '/* v8 ignore start */', 'describe.only(', 'test.todo(', 'xit(', "t.skip('x')"]) {
      expect(g.evaluateGate({ ...clean, added: [line] }).reasons.some((r) => r.startsWith('gaming:'))).toBe(true);
    }
  });
  it('rejects config, lock, workflow, ignore-file and test paths even as the only change', async () => {
    const g = await gate();
    for (const p of ['eslint.config.mjs', 'packages/server/tsconfig.json', 'package-lock.json', 'packages/server/package.json', '.github/workflows/ci.yml', '.eslintignore', '.gitignore', 'vitest.config.mts', `${S}/__tests__/a.test.ts`, '.security-review/guidance.json']) {
      const r = g.evaluateGate({ ...clean, file: p, statuses: [{ status: 'M', path: p }], numstat: [{ path: p, added: 1, removed: 1 }], added: [] });
      expect(r.reasons.some((x) => x.startsWith('forbidden path:'))).toBe(true);
    }
  });
  it('fails when before/after were not measured', async () => {
    expect((await gate()).evaluateGate({ ...clean, before: null, after: null, added: [] }).reasons).toContain('scan missing: before/after not measured');
  });
});

describe('finding-fix lane source', () => {
  const lane = () => new FindingFixSourceService(db);
  const proposals = () => db.prepare("SELECT id, title, type, status, description, evidence_refs_json AS refs, grounding_json AS g FROM self_improvements WHERE evidence_refs_json LIKE '%\"finding-fix:%' ORDER BY created_at").all() as Array<{ id: string; title: string; type: string; status: string; description: string; refs: string; g: string }>;

  it('is off by default: nothing scanned, nothing recorded', () => {
    const marker = path.join(repo, 'scanned');
    write('spy.mjs', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, '1'); console.log('{}');\n`);
    expect(findingFixMode({})).toBe('off');
    expect(lane().run(new Date(), env({ FINDING_FIX_GATE_SCRIPT: path.join(repo, 'spy.mjs') }))).toEqual({ created: 0, skipped: 'disabled', found: null });
    expect(fs.existsSync(marker)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'finding_fix_candidates'").get()).toEqual({ n: 0 });
  });

  it('shadow records counts and would-be proposals in one judgments row and never creates a proposal', () => {
    const r = lane().run(new Date(), env({ FINDING_FIX_LANE: 'shadow' }));
    expect(r).toEqual({ created: 0, skipped: 'shadow', found: 3 });
    expect(proposals()).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) n FROM self_improvements').get()).toEqual({ n: 0 });
    const row = db.prepare("SELECT mode, decision, answers_json AS a FROM judgments WHERE judgment = 'finding_fix_candidates'").get() as { mode: string; decision: string; a: string };
    expect(row).toMatchObject({ mode: 'shadow', decision: 'recorded' });
    const a = JSON.parse(row.a);
    expect(a).toMatchObject({ total: 3, by_rule: { 'no-useless-escape': 2, 'preserve-caught-error': 1 }, files: 1 });
    expect(a.would_propose).toHaveLength(1);
    expect(a.top[0].rule).toBe('preserve-caught-error'); // rule priority within the smallest file
  });

  it('shadow with a missing scanner is insufficient (null counts), not 0 findings', () => {
    const r = lane().run(new Date(), env({ FINDING_FIX_LANE: 'shadow', FINDING_FIX_ESLINT_FROM: path.join(repo, 'nowhere') }));
    expect(r.found).toBeNull();
    const row = db.prepare("SELECT decision, answers_json AS a FROM judgments WHERE judgment = 'finding_fix_candidates'").get() as { decision: string; a: string };
    expect(row.decision).toBe('insufficient');
    expect(JSON.parse(row.a)).toMatchObject({ total: null, by_rule: null });
  });

  it('on: one in flight, two per day, a finding never proposed twice; the run gets the gate env and the 60-line diff cap', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const e = env({ FINDING_FIX_LANE: 'on' });
    expect(lane().run(now, e)).toMatchObject({ created: 1, found: 3 });
    expect(lane().run(now, e)).toMatchObject({ created: 0, skipped: 'one in flight' });
    const [first] = proposals();
    expect(first.type).toBe('refactor');
    expect(first.status).toBe('proposed');
    expect(first.title).toBe(`Fix only finding preserve-caught-error at ${TARGET}:4`);
    expect(first.description).toContain('Disallow losing originally caught error');
    expect(first.description).toContain("throw new Error('load failed');");
    const refs = JSON.parse(first.refs) as string[];
    expect(refs).toEqual(expect.arrayContaining([expect.stringMatching(/^finding-fix:primary\/[0-9a-f]{16}$/), 'finding-rule:preserve-caught-error', `finding-file:${TARGET}`, expect.stringMatching(/^finding-pack:[0-9a-f]{16}$/)]));
    expect(JSON.parse(first.g).runtimeCommand).toContain('npm run test:finding-fix:grounded');
    expect(oracleLaneSkipsPanel({ source: 'gap_analysis', evidenceRefs: refs }, { ORACLE_LANES_SKIP_PANEL: 'true' })).toBe(false);

    db.prepare("UPDATE self_improvements SET status = 'scheduled' WHERE id = ?").run(first.id);
    new AutonomousGoalGenerator(db).generateImprovement(first.id);
    const goal = db.prepare('SELECT id FROM goals WHERE improvement_id = ?').get(first.id) as { id: string };
    const checkEnv = findingFixCheckEnv(db, goal.id);
    expect(checkEnv).toMatchObject({ FINDING_FIX_RULE: 'preserve-caught-error', FINDING_FIX_FILE: TARGET });
    expect(checkEnv.FINDING_FIX_ID).toMatch(/^[0-9a-f]{16}$/);
    expect(FINDING_FIX_DIFF_MAX).toBe(60);

    db.prepare("UPDATE self_improvements SET status = 'verified' WHERE id = ?").run(first.id);
    expect(lane().run(now, e)).toMatchObject({ created: 1 });
    db.prepare("UPDATE self_improvements SET status = 'verified'").run();
    expect(lane().run(now, e)).toMatchObject({ created: 0, skipped: 'daily cap reached' });
    const next = new Date(now.getTime() + 2 * 86_400_000);
    expect(lane().run(next, e)).toMatchObject({ created: 1 });
    expect(lane().run(next, { ...e })).toMatchObject({ created: 0 });
    db.prepare("UPDATE self_improvements SET status = 'verified'").run();
    expect(lane().run(next, e)).toMatchObject({ created: 0, skipped: 'no new finding' }); // all 3 proposed once
    expect(new Set(proposals().map((p) => p.title)).size).toBe(3);
  });

  it('the in-code check fails when the gate script is missing or a ref is missing, and runs Djimitflo\'s gate otherwise', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ffl-out-'));
    try {
      const mk = (refs: string[]) => {
        const id = `si-${refs.length}`;
        db.prepare("INSERT INTO self_improvements (id, type, title, description, rationale, source, status, priority, evidence_refs_json, created_at, updated_at) VALUES (?, 'refactor', ?, 'd', 'r', 'gap_analysis', 'executing', 0.6, ?, datetime('now'), datetime('now'))").run(id, id, JSON.stringify(refs));
        db.prepare("INSERT INTO goals (id, improvement_id, objective, risk_class, status) VALUES (?, ?, 't', 'low', 'running')").run(`g-${id}`, id);
        return `g-${id}`;
      };
      expect(findingFixCheck(db, mk(['test-gap:x']), repo, out)).toBeNull();
      const inputs = await inputsFor('no-useless-escape');
      const partial = mk([`finding-fix:primary/${inputs.FINDING_FIX_ID}`, `finding-rule:no-useless-escape`, `finding-file:${TARGET}`]);
      write(TARGET, BASE.replace("'credentials\\.json'", "'credentials.json'"));
      expect(findingFixCheck(db, partial, repo, out)).toMatchObject({ name: 'test:finding-fix', status: 'fail', exit_status: 1 });
      const full = mk([`finding-fix:primary/${inputs.FINDING_FIX_ID}`, `finding-rule:no-useless-escape`, `finding-file:${TARGET}`, 'finding-occ:0', `finding-pack:${inputs.FINDING_FIX_PACK}`]);
      expect(findingFixCheck(db, full, repo, out)).toMatchObject({ status: 'pass', exit_status: 0 });
      expect(findingFixCheck(db, full, repo, out, { FINDING_FIX_GATE_SCRIPT: path.join(repo, 'missing.mjs') })).toMatchObject({ status: 'fail', reason: 'missing_gate' });
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
  });

  it('registers its flags', () => {
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'FINDING_FIX_LANE', acting: true });
    expect(EVOLUTION_FLAGS).toContainEqual({ name: 'FINDING_FIX_MAX_PER_DAY', acting: true });
  });
});
